#!/usr/bin/env python3
"""Explicit, resumable Claude-mem raw archive import. Never calls an LLM."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid

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
        os.replace(temporary, path)
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


def points_for_row(item, tokenizer, max_tokens=480, overlap=32):
    if not (0 <= overlap < max_tokens <= 480):
        raise ValueError('invalid_chunk_size')
    row = item['row']
    source = item['source_project']
    table = item['source_table']
    digest = row_digest(row)
    identity = f'{source}\0{table}\0{row["id"]}\0{row.get("memory_session_id")}\0{digest}'
    anchor = str(uuid.uuid5(NAMESPACE, identity + '\0anchor'))
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
        point_id = anchor if index == 0 else str(uuid.uuid5(
            NAMESPACE, identity + f'\0{field}\0{start}\0{end}'))
        payload = {'source': 'claude-mem', 'source_type': 'imported_legacy',
                   'origin': 'assistant_report', 'speaker_role': 'assistant',
                   'actor': 'claude-mem', 'label': LABEL,
                   'source_project': source, 'source_table': table, 'source_id': row['id'],
                   'source_session': row.get('memory_session_id'),
                   'evidence_at': row.get('created_at'),
                   'source_content_hash': row.get('content_hash'),
                   'raw_content_sha256': digest, 'field': field,
                   'start': start, 'end': end, 'text': text,
                   'anchor_id': anchor, 'collection': item['collection']}
        if index == 0:
            payload['raw_row'] = row
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
    from urllib.parse import urlsplit
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
                            prefer_grpc=False, check_compatibility=False)
    except Exception:
        transport.close()
        raise


def ensure_raw_collection(client, name):
    from qdrant_client.models import Distance, HnswConfigDiff, VectorParams
    import mem0_adapter as adapter
    if not valid_collection(name):
        raise ValueError('invalid_raw_collection')
    try:
        adapter.verify_collection(client, name, adapter.FINGERPRINT)
    except Exception:
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


def snapshot_digest(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def save_checkpoint(path, digest, line, offset):
    private_atomic(path, lambda stream: stream.write(json.dumps(
        {'snapshot_sha256': digest, 'line': line, 'offset': offset}) + '\n'))


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
    cursor = {'line': 0, 'offset': 0, 'snapshot_sha256': digest}
    if checkpoint.exists():
        if os.name != 'nt' and (checkpoint.stat().st_uid != os.getuid() or
                                checkpoint.stat().st_mode & 0o777 != 0o600):
            raise ValueError('private_checkpoint_required')
        cursor = json.loads(checkpoint.read_text(encoding='utf-8'))
        if cursor.get('snapshot_sha256') != digest or \
                type(cursor.get('line')) is not int or cursor['line'] < 0 or \
                type(cursor.get('offset')) is not int or cursor['offset'] < 0:
            raise ValueError('checkpoint_snapshot_mismatch')
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
        count = 0
        checked = set()
        with source.open('r', encoding='utf-8') as stream:
            for line_index, line in enumerate(stream):
                if line_index < cursor['line']:
                    continue
                item = json.loads(line)
                name = item['collection']
                if name not in checked:
                    ensure_raw_collection(client, name)
                    checked.add(name)
                pieces = points_for_row(item, embedder.tokenizer)
                start = cursor['offset'] if line_index == cursor['line'] else 0
                for offset in range(start, len(pieces), options.batch_size):
                    batch = pieces[offset:offset + options.batch_size]
                    existing = {str(point.id) for point in client.retrieve(
                        name, ids=[part['id'] for part in batch], with_payload=False,
                        with_vectors=False)}
                    missing = [part for part in batch if part['id'] not in existing]
                    points = []
                    for part in missing:
                        if len(embedder.tokenizer.encode('passage: ' + part['text']).ids) > 512:
                            raise ValueError('chunk_exceeds_model_context')
                        points.append(PointStruct(id=part['id'],
                            vector=embedder.embed(part['text'], 'add'),
                            payload=part['payload']))
                    if points:
                        result = client.upsert(name, points=points, wait=True)
                        if str(result.status).lower() not in ('completed', 'updatestatus.completed'):
                            raise RuntimeError('upsert_not_acknowledged')
                        count += len(points)
                    next_offset = offset + len(batch)
                    save_checkpoint(checkpoint, digest,
                                    line_index + (next_offset >= len(pieces)),
                                    0 if next_offset >= len(pieces) else next_offset)
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
