#!/usr/bin/env python3
"""Explicit, resumable Claude-mem raw archive import. Never calls an LLM."""

import argparse
from collections import OrderedDict
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'python'))
LABEL = 'Claude-mem legado, gerado, não verificado'
NAMESPACE = uuid.UUID('ab6492ee-a65c-4e2a-954f-378435672b9c')
CONTENT_FIELDS = ('text', 'title', 'subtitle', 'facts', 'narrative', 'concepts',
                  'files_read', 'files_modified', 'request', 'investigated',
                  'learned', 'completed', 'next_steps', 'files_edited', 'notes',
                  'metadata')
TABLES = ('observations', 'session_summaries')


class CharacterTokenizer:
    """Small deterministic tokenizer for isolated contract tests."""

    def encode(self, value, add_special_tokens=False):
        offsets = [(i, i + 1) for i in range(len(value))]
        return type('Encoding', (), {'offsets': offsets, 'ids': list(range(len(value)))})()

    def no_truncation(self):
        pass


class EmbeddingCache:
    def __init__(self, embedder, capacity=4096):
        self.embedder = embedder
        self.capacity = capacity
        self.vectors = OrderedDict()

    def get(self, text):
        if text in self.vectors:
            self.vectors.move_to_end(text)
        else:
            self.vectors[text] = tuple(self.embedder.embed(text, 'add'))
            if len(self.vectors) > self.capacity:
                self.vectors.popitem(last=False)
        return list(self.vectors[text])


def valid_collection(value):
    return isinstance(value, str) and value.endswith('_claude_mem_raw') and \
        1 <= len(value) <= 128 and value[0].isascii() and value[0].isalnum() and \
        all(c.isascii() and (c.isalnum() or c in '._-') for c in value)


def validate_mapping(mapping):
    if not isinstance(mapping, list) or not mapping:
        raise ValueError('mapping_required')
    seen = set()
    for item in mapping:
        if not isinstance(item, dict) or set(item) != {'source_project', 'collection'} or \
                not isinstance(item['source_project'], str) or not item['source_project'] or \
                item['source_project'] in seen or not valid_collection(item['collection']):
            raise ValueError('invalid_mapping')
        seen.add(item['source_project'])


def private_atomic(path, writer):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name != 'nt' and path.parent.stat().st_mode & 0o077:
        raise ValueError('private_directory_required')
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            writer(stream)
            stream.flush()
            os.fsync(stream.fileno())
        for attempt in range(8):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                # Antivirus and backup tools briefly hold a fresh file open on Windows.
                if os.name != 'nt' or attempt == 7:
                    raise
                time.sleep(0.25 * (attempt + 1))
        if os.name != 'nt':
            parent_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
    finally:
        if temporary.exists():
            temporary.unlink()


def snapshot(source, mapping, output):
    """One SQLite read transaction for all selected projects and both raw tables."""
    validate_mapping(mapping)
    source = Path(source).resolve(strict=True)
    output = Path(output).resolve()
    if source == output:
        raise ValueError('source_output_same')
    selected = {item['source_project']: item['collection'] for item in mapping}
    count = 0
    connection = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')

        def write(stream):
            nonlocal count
            placeholders = ','.join('?' for _ in selected)
            for table in TABLES:
                columns = [column[1] for column in connection.execute(f'PRAGMA table_info({table})')]
                if not {'id', 'project', 'memory_session_id', 'created_at'} <= set(columns):
                    raise ValueError('unsupported_claude_mem_schema')
                cursor = connection.execute(
                    f'SELECT * FROM {table} WHERE project IN ({placeholders}) ORDER BY id',
                    tuple(selected))
                for values in cursor:
                    row = dict(zip(columns, values))
                    item = {'source_project': row['project'], 'source_table': table,
                            'collection': selected[row['project']], 'row': row}
                    stream.write(json.dumps(item, ensure_ascii=False, separators=(',', ':')) + '\n')
                    count += 1

        private_atomic(output, write)
        connection.execute('COMMIT')
    finally:
        connection.close()
    return count


def row_digest(row):
    return hashlib.sha256(json.dumps(row, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def source_identity(item):
    row = item['row']
    return json.dumps([item['collection'], item['source_project'], item['source_table'],
                       row['id'], row.get('memory_session_id')], ensure_ascii=False,
                      separators=(',', ':'))


def chunk_id(identity, index):
    return str(uuid.uuid5(NAMESPACE, identity + ('\0anchor' if index == 0 else f'\0{index}')))


def points_for_row(item, tokenizer, max_tokens=480, overlap=32):
    import mem0_adapter as adapter
    if not (0 <= overlap < max_tokens <= 480):
        raise ValueError('invalid_chunk_size')
    row = item['row']
    source = item['source_project']
    table = item['source_table']
    digest = row_digest(row)
    identity = source_identity(item)
    anchor = chunk_id(identity, 0)
    pieces = []
    for field in CONTENT_FIELDS:
        value = row.get(field)
        if not isinstance(value, str) or not value:
            continue
        offsets = tokenizer.encode(value, add_special_tokens=False).offsets
        if not offsets:
            offsets = [(0, len(value))]
        index = 0
        while index < len(offsets):
            stop = min(index + max_tokens, len(offsets))
            start_char = 0 if index == 0 else offsets[index][0]
            end_char = len(value) if stop == len(offsets) else offsets[stop][0]
            while stop > index + 1 and len(tokenizer.encode(
                    'passage: ' + value[start_char:end_char]).offsets) > 512:
                stop -= 1
                end_char = offsets[stop][0]
            if end_char <= start_char:
                raise ValueError('token_offsets_invalid')
            if len(tokenizer.encode('passage: ' + value[start_char:end_char]).offsets) > 512:
                raise ValueError('single_token_exceeds_model_context')
            pieces.append((field, start_char, end_char, value[start_char:end_char]))
            if stop == len(offsets):
                break
            index = max(index + 1, stop - overlap)
    if not pieces:
        pieces = [('empty', 0, 0, f'{source} {table} {row["id"]}')]
    result = []
    for index, (field, start, end, text) in enumerate(pieces):
        point_id = chunk_id(identity, index)
        payload = {'source': 'claude-mem', 'source_type': 'imported_legacy',
                   'origin': 'assistant_report', 'speaker_role': 'assistant',
                   'actor': 'claude-mem', 'label': LABEL,
                   'source_project': source, 'source_table': table, 'source_id': row['id'],
                   'source_session': row.get('memory_session_id'),
                   'evidence_at': row.get('created_at'),
                   'source_content_hash': row.get('content_hash'),
                   'raw_content_sha256': digest,
                   'embedding_text_sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
                   'embedding_fingerprint': adapter.FINGERPRINT,
                   'import_identity': anchor, 'chunk_ordinal': index,
                   'field': field,
                   'start': start, 'end': end, 'text': text,
                   'anchor_id': anchor, 'collection': item['collection']}
        if index == 0:
            payload['raw_row'] = row
            payload['chunk_count'] = len(pieces)
        result.append({'id': point_id, 'payload': payload, 'text': text})
    return result


def preview_hit(point, collection, max_chars=240):
    payload = point.payload if hasattr(point, 'payload') else point['payload']
    return {'label': LABEL, 'collection': collection,
            'source_project': payload['source_project'],
            'source_table': payload['source_table'], 'source_id': payload['source_id'],
            'preview': payload.get('text', '')[:max_chars],
            'read_id': payload['anchor_id']}


def read_raw(client, collection, identifier):
    identifier = str(uuid.UUID(str(identifier)))
    if not client.collection_exists(collection):
        raise ValueError('raw_anchor_not_found')
    points = client.retrieve(collection, ids=[identifier], with_payload=True)
    if len(points) != 1 or points[0].payload.get('anchor_id') != identifier or \
            'raw_row' not in points[0].payload:
        raise ValueError('raw_anchor_not_found')
    return {'label': LABEL, 'collection': collection,
            'source_project': points[0].payload['source_project'],
            'source_table': points[0].payload['source_table'],
            'row': points[0].payload['raw_row']}


def safe_key(file):
    path = Path(file).expanduser()
    stat = path.lstat()
    if os.name != 'nt' and (not path.is_file() or stat.st_uid != os.getuid() or
                            stat.st_mode & 0o777 != 0o600 or
                            path.parent.stat().st_mode & 0o077):
        raise ValueError('private_key_required')
    value = path.read_text(encoding='utf-8').rstrip('\r\n')
    if not value or len(value) > 8192 or not value.isascii() or any(c.isspace() for c in value):
        raise ValueError('invalid_key')
    return value


def client_for(options):
    import mem0_adapter as adapter
    from qdrant_client import QdrantClient
    target = urlsplit(options.url)
    if target.scheme != 'https' or not target.hostname or target.path not in ('', '/') or \
            target.query or target.fragment or target.username or target.password:
        raise ValueError('explicit_https_destination_required')
    connection = {'url': options.url.rstrip('/') + '/', 'hostname': target.hostname,
                  'address': options.address, 'port': target.port or 443,
                  'protocol': 'https:', 'servername': target.hostname,
                  'allowPublic': True}
    transport = adapter.PinnedTransport(connection)
    try:
        key = safe_key(options.api_key_file)
        return QdrantClient(url=connection['url'], api_key=key, transport=transport,
                            trust_env=False, follow_redirects=False,
                            prefer_grpc=False, check_compatibility=False, timeout=30)
    except Exception:
        transport.close()
        raise


def ensure_raw_collection(client, name):
    from qdrant_client.models import Distance, HnswConfigDiff, VectorParams
    from qdrant_client.http.exceptions import ResponseHandlingException
    import mem0_adapter as adapter
    import httpx
    if not valid_collection(name):
        raise ValueError('invalid_raw_collection')

    def ensure():
        try:
            adapter.verify_collection(client, name, adapter.FINGERPRINT)
        except Exception as error:
            if isinstance(error, (httpx.TransportError, ResponseHandlingException,
                                  httpx.HTTPStatusError)) or \
                    getattr(error, 'status_code', 404) != 404:
                raise
            if client.collection_exists(name):
                raise
            client.create_collection(collection_name=name,
                                     vectors_config=VectorParams(size=384, distance=Distance.COSINE,
                                                                 on_disk=True),
                                     on_disk_payload=True, hnsw_config=HnswConfigDiff(on_disk=True),
                                     metadata={'cbs_embedding_fingerprint': adapter.FINGERPRINT,
                                               'cbs_source': 'claude-mem-raw-v1'})
            adapter.verify_collection(client, name, adapter.FINGERPRINT)
        if (client.get_collection(name).config.metadata or {}).get('cbs_source') != 'claude-mem-raw-v1':
            raise ValueError('raw_collection_marker_mismatch')

    retry_transport(ensure)


def snapshot_digest(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def file_digest(path):
    return snapshot_digest(Path(path).resolve(strict=True))


def snapshot_mapping(path, with_count=False):
    mapping = {}
    count = 0
    with Path(path).open('r', encoding='utf-8') as stream:
        for line in stream:
            count += 1
            item = json.loads(line)
            project, collection = item['source_project'], item['collection']
            if not isinstance(project, str) or not project or not valid_collection(collection):
                raise ValueError('invalid_snapshot_mapping')
            if project in mapping and mapping[project] != collection:
                raise ValueError('inconsistent_snapshot_mapping')
            mapping[project] = collection
    return (mapping, count) if with_count else mapping


def import_identity(options, mapping):
    import mem0_adapter as adapter
    target = urlsplit(options.url)
    if target.scheme.lower() != 'https' or not target.hostname or \
            target.path not in ('', '/') or target.query or target.fragment or \
            target.username or target.password:
        raise ValueError('explicit_https_destination_required')
    address = ipaddress.ip_address(options.address)
    if address.version != 4 or not address.is_global:
        raise ValueError('public_ipv4_destination_required')
    return {'version': 2, 'url': f'https://{target.hostname.lower()}:{target.port or 443}',
            'address': str(address), 'public_mode': True,
            'collection_map': mapping,
            'embedding_fingerprint': adapter.FINGERPRINT,
            'model_sha256': file_digest(options.model),
            'tokenizer_sha256': file_digest(options.tokenizer),
            'dimension': 384, 'chunk_schema': 'claude-mem-raw-v2-480-32'}


def save_checkpoint(path, digest, line, offset, identity):
    private_atomic(path, lambda stream: stream.write(json.dumps(
        {'snapshot_sha256': digest, 'line': line, 'offset': offset,
         'identity': identity}) + '\n'))


def acknowledged(result, action):
    if str(result.status).lower() not in ('completed', 'updatestatus.completed'):
        raise RuntimeError(f'{action}_not_acknowledged')


def owned_point(point, anchor, ordinal):
    payload = point.payload or {}
    if payload.get('source') != 'claude-mem' or payload.get('import_identity') != anchor or \
            payload.get('chunk_ordinal') != ordinal or payload.get('anchor_id') != anchor:
        raise ValueError('raw_point_ownership_mismatch')


def retry_transport(operation):
    import httpx
    from qdrant_client.http.exceptions import ResponseHandlingException
    for attempt in range(3):
        try:
            return operation()
        except Exception as error:
            cause = error.source if isinstance(error, ResponseHandlingException) else error
            if not isinstance(cause, httpx.TransportError) or attempt == 2:
                raise
            time.sleep((0.3, 0.8)[attempt])


def import_snapshot(options, client=None, embedder=None):
    import mem0_adapter as adapter
    from qdrant_client.models import PointStruct
    source = Path(options.snapshot).resolve(strict=True)
    checkpoint = Path(options.checkpoint).resolve()
    if source == checkpoint:
        raise ValueError('snapshot_checkpoint_same')
    if os.name != 'nt' and (source.stat().st_uid != os.getuid() or
                            source.stat().st_mode & 0o777 != 0o600):
        raise ValueError('private_snapshot_required')
    digest = snapshot_digest(source)
    mapping, line_count = snapshot_mapping(source, with_count=True)
    identity = import_identity(options, mapping)
    cursor = {'line': 0, 'offset': 0, 'snapshot_sha256': digest}
    if checkpoint.exists():
        if os.name != 'nt' and (checkpoint.stat().st_uid != os.getuid() or
                                checkpoint.stat().st_mode & 0o777 != 0o600):
            raise ValueError('private_checkpoint_required')
        cursor = json.loads(checkpoint.read_text(encoding='utf-8'))
        if not isinstance(cursor, dict):
            raise ValueError('checkpoint_invalid')
        if 'identity' not in cursor:
            raise ValueError('checkpoint_identity_required')
        if cursor['identity'] != identity:
            raise ValueError('checkpoint_identity_mismatch')
        if cursor.get('snapshot_sha256') != digest or \
                type(cursor.get('line')) is not int or cursor['line'] < 0 or \
                type(cursor.get('offset')) is not int or cursor['offset'] < 0:
            raise ValueError('checkpoint_snapshot_mismatch')
        if cursor['line'] > line_count or \
                (cursor['line'] == line_count and cursor['offset'] != 0):
            raise ValueError('checkpoint_cursor_out_of_range')
    # A completed checkpoint still verifies and repairs the remote snapshot.
    resume_line, resume_offset = (0, 0) if cursor['line'] == line_count else \
        (cursor['line'], cursor['offset'])
    owned_client = client is None
    if owned_client:
        client = client_for(options)
    try:
        if embedder is None:
            os.environ['OMP_NUM_THREADS'] = '2'
            os.environ['OPENBLAS_NUM_THREADS'] = '1'
            os.environ['MKL_NUM_THREADS'] = '1'
            os.environ['CBS_MEMORIA_MODEL'] = str(Path(options.model).resolve(strict=True))
            os.environ['CBS_MEMORIA_TOKENIZER'] = str(Path(options.tokenizer).resolve(strict=True))
            embedder = adapter.E5Embedder()
        embedder.tokenizer.no_truncation()
        embedding_cache = EmbeddingCache(embedder)
        count = 0
        checked = set()

        def write_collection(name, entries):
            nonlocal count
            if name not in checked:
                ensure_raw_collection(client, name)
                checked.add(name)
            existing = {str(point.id): point for point in retry_transport(lambda:
                client.retrieve(name, ids=[part['id'] for part, _, _, _ in entries],
                                with_payload=True, with_vectors=False))}
            for part, _, _, _ in entries:
                remote = existing.get(part['id'])
                if remote:
                    owned_point(remote, part['payload']['anchor_id'],
                                part['payload']['chunk_ordinal'])
            for part, _, _, row_identity in entries:
                if part['payload']['chunk_ordinal'] != 0:
                    continue
                anchor = part['id']
                old_anchor = existing.get(anchor)
                old_count = old_anchor.payload.get('chunk_count', 0) if old_anchor else 0
                if type(old_count) is not int or old_count < 0:
                    raise ValueError('raw_chunk_count_invalid')
                new_count = part['payload']['chunk_count']
                for start in range(new_count, old_count, options.batch_size):
                    old_ids = [chunk_id(row_identity, index) for index in
                               range(start, min(start + options.batch_size, old_count))]
                    obsolete = retry_transport(lambda: client.retrieve(
                        name, ids=old_ids, with_payload=True, with_vectors=False))
                    for point in obsolete:
                        owned_point(point, anchor, start + old_ids.index(str(point.id)))
                    if obsolete:
                        acknowledged(retry_transport(lambda: client.delete(
                            name, points_selector=[point.id for point in obsolete], wait=True)),
                            'delete')
            points = []
            for part, _, _, _ in entries:
                remote = existing.get(part['id'])
                if remote and remote.payload.get('embedding_text_sha256') == \
                        part['payload']['embedding_text_sha256'] and \
                        remote.payload.get('embedding_fingerprint') == \
                        part['payload']['embedding_fingerprint']:
                    if remote.payload != part['payload']:
                        acknowledged(retry_transport(lambda: client.overwrite_payload(
                            name, payload=part['payload'], points=[part['id']], wait=True)),
                            'payload')
                    continue
                if len(embedder.tokenizer.encode('passage: ' + part['text']).ids) > 512:
                    raise ValueError('chunk_exceeds_model_context')
                points.append(PointStruct(id=part['id'],
                    vector=embedding_cache.get(part['text']), payload=part['payload']))
            if points:
                acknowledged(retry_transport(lambda: client.upsert(
                    name, points=points, wait=True)), 'upsert')
                count += len(points)

        def write_window(entries):
            by_collection = {}
            for entry in entries:
                by_collection.setdefault(entry[0]['payload']['collection'], []).append(entry)
            for name, collection_entries in by_collection.items():
                write_collection(name, collection_entries)
            _, line, offset, _ = entries[-1]
            save_checkpoint(checkpoint, digest, line, offset, identity)

        pending = []
        with source.open('r', encoding='utf-8') as stream:
            for line_index, line in enumerate(stream):
                if line_index < resume_line:
                    continue
                item = json.loads(line)
                pieces = points_for_row(item, embedder.tokenizer)
                if line_index == resume_line and resume_offset >= len(pieces) and \
                        resume_offset != 0:
                    raise ValueError('checkpoint_cursor_out_of_range')
                row_identity = source_identity(item)
                for offset, part in enumerate(pieces, 1):
                    if line_index == resume_line and offset <= resume_offset:
                        continue
                    if len(pending) == options.batch_size:
                        write_window(pending)
                        pending = []
                    end_of_row = offset == len(pieces)
                    pending.append((part, line_index + end_of_row,
                                    0 if end_of_row else offset, row_identity))
            if pending:
                write_window(pending)
        return count
    finally:
        if owned_client:
            client.close()


def run_search(options):
    import mem0_adapter as adapter
    if not valid_collection(options.collection):
        raise ValueError('invalid_raw_collection')
    client = client_for(options)
    try:
        adapter.verify_collection(client, options.collection, adapter.FINGERPRINT)
        if (client.get_collection(options.collection).config.metadata or {}).get('cbs_source') != 'claude-mem-raw-v1':
            raise ValueError('raw_collection_marker_mismatch')
        if options.command == 'read':
            print(json.dumps(read_raw(client, options.collection, options.id), ensure_ascii=False))
        else:
            os.environ['CBS_MEMORIA_MODEL'] = str(Path(options.model).resolve(strict=True))
            os.environ['CBS_MEMORIA_TOKENIZER'] = str(Path(options.tokenizer).resolve(strict=True))
            embedder = adapter.E5Embedder()
            embedder.tokenizer.no_truncation()
            if len(embedder.tokenizer.encode('query: ' + options.query).ids) > 512:
                raise ValueError('query_exceeds_model_context')
            vector = embedder.embed(options.query, 'search')
            hits = client.query_points(options.collection, query=vector,
                                       limit=options.limit, with_payload=True).points
            print(json.dumps([preview_hit(hit, options.collection) for hit in hits], ensure_ascii=False))
    finally:
        client.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='command', required=True)
    snap = actions.add_parser('snapshot')
    snap.add_argument('--source', required=True)
    snap.add_argument('--mapping-file', required=True)
    snap.add_argument('--output', required=True)
    imp = actions.add_parser('import')
    imp.add_argument('--snapshot', required=True)
    imp.add_argument('--checkpoint', required=True)
    imp.add_argument('--batch-size', type=int, default=64)
    search = actions.add_parser('search')
    search.add_argument('--query', required=True)
    search.add_argument('--limit', type=int, default=5)
    read = actions.add_parser('read')
    read.add_argument('--id', required=True)
    for action in (imp, search, read):
        action.add_argument('--url', required=True)
        action.add_argument('--address', required=True)
        action.add_argument('--api-key-file', required=True)
        action.add_argument('--collection', required=action != imp)
        action.add_argument('--model', required=action != read)
        action.add_argument('--tokenizer', required=action != read)
        action.add_argument('--yes', action='store_true', required=True)
    options = parser.parse_args(argv)
    try:
        if options.command == 'snapshot':
            mapping = json.loads(Path(options.mapping_file).read_text(encoding='utf-8'))
            print(json.dumps({'snapshot_rows': snapshot(options.source, mapping, options.output)}))
        elif options.command == 'import':
            if not 1 <= options.batch_size <= 128:
                raise ValueError('invalid_batch_size')
            print(json.dumps({'upserted_points': import_snapshot(options)}))
        else:
            if options.command == 'search' and not 1 <= options.limit <= 20:
                raise ValueError('invalid_limit')
            run_search(options)
        return 0
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        print(f'blocked: {type(error).__name__}: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
