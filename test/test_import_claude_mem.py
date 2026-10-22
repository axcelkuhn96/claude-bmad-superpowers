import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx


SCRIPT = Path(__file__).resolve().parents[1] / 'base/memoria/import-claude-mem.py'
spec = importlib.util.spec_from_file_location('import_claude_mem', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImportClaudeMemTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.root / 'source.db'
        with sqlite3.connect(self.db) as db:
            db.executescript('''
                CREATE TABLE observations(id INTEGER PRIMARY KEY, project TEXT, memory_session_id TEXT,
                    text TEXT, facts TEXT, created_at TEXT, content_hash TEXT);
                CREATE TABLE session_summaries(id INTEGER PRIMARY KEY, project TEXT, memory_session_id TEXT,
                    request TEXT, notes TEXT, created_at TEXT);
            ''')
            db.executemany('INSERT INTO observations VALUES(?,?,?,?,?,?,?)', [
                (1, 'Projeto-A', 'a', 'Olá memória', '["fato"]', '2024-01-01T00:00:00Z', 'src1'),
                (2, 'Projeto-A/subprojeto', 'b', 'filho', None, '2024-01-02T00:00:00Z', None),
                (3, 'unselected', 'c', 'segredo', None, '2024-01-03T00:00:00Z', None),
            ])
            db.execute('INSERT INTO session_summaries VALUES(?,?,?,?,?,?)',
                       (4, 'Projeto-A', 'd', 'pedido', 'próximo', '2024-01-04T00:00:00Z'))

    def test_snapshot_selects_only_explicit_aliases_and_preserves_raw_fields(self):
        mapping = [{'source_project': 'Projeto-A', 'collection': 'cbs-projeto-a_claude_mem_raw'},
                   {'source_project': 'Projeto-A/subprojeto',
                    'collection': 'cbs-projeto-a_claude_mem_raw'}]
        out = self.root / 'snapshot.jsonl'
        count = module.snapshot(self.db, mapping, out)
        rows = [json.loads(line) for line in out.read_text().splitlines()]
        self.assertEqual(count, 3)
        self.assertEqual([r['row']['id'] for r in rows], [1, 2, 4])
        self.assertEqual(rows[0]['row']['text'], 'Olá memória')
        self.assertEqual(rows[0]['row']['facts'], '["fato"]')
        self.assertEqual(rows[0]['source_table'], 'observations')
        self.assertEqual(rows[2]['source_table'], 'session_summaries')
        self.assertEqual(out.stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM observations').fetchone()[0], 3)

    def test_chunks_cover_long_unicode_field_and_anchor_preserves_row_once(self):
        row = {'source_project': 'Projeto-A', 'source_table': 'observations',
               'collection': 'cbs-projeto-a_claude_mem_raw',
               'row': {'id': 7, 'memory_session_id': 's', 'created_at': '2024',
                       'text': 'árvore ' * 1200}}
        points = module.points_for_row(row, module.CharacterTokenizer(), max_tokens=100, overlap=10)
        spans = [(p['payload']['start'], p['payload']['end']) for p in points]
        self.assertEqual(spans[0][0], 0)
        self.assertEqual(spans[-1][1], len(row['row']['text']))
        self.assertTrue(all(left[1] >= right[0] for left, right in zip(spans, spans[1:])))
        self.assertEqual(sum('raw_row' in p['payload'] for p in points), 1)
        self.assertEqual(points[0]['payload']['raw_row'], row['row'])
        self.assertEqual(len({p['id'] for p in points}), len(points))
        self.assertEqual([p['id'] for p in points],
                         [p['id'] for p in module.points_for_row(row, module.CharacterTokenizer(), 100, 10)])

    def test_preview_is_labelled_and_full_pointer_is_project_scoped(self):
        point = {'id': 'point-1', 'payload': {'source_project': 'Projeto-A',
                 'source_table': 'observations', 'source_id': 1,
                 'anchor_id': 'anchor-1', 'text': 'x' * 800}}
        result = module.preview_hit(point, 'cbs-projeto-a_claude_mem_raw', max_chars=80)
        self.assertIn('Claude-mem legado, gerado, não verificado', result['label'])
        self.assertEqual(len(result['preview']), 80)
        self.assertEqual(result['read_id'], 'anchor-1')
        self.assertEqual(result['collection'], 'cbs-projeto-a_claude_mem_raw')

    def test_resume_replays_acknowledged_batch_without_duplicate_points(self):
        from qdrant_client import QdrantClient

        class Embedder:
            tokenizer = module.CharacterTokenizer()

            def embed(self, text, memory_action):
                return [1.0] + [0.0] * 383

        out = self.root / 'snapshot.jsonl'
        module.snapshot(self.db, [{'source_project': 'Projeto-A',
                                  'collection': 'cbs-projeto-a_claude_mem_raw'}], out)
        options = self.options(out, batch_size=1)
        client = QdrantClient(':memory:')
        original = module.save_checkpoint
        attempts = 0

        def interrupt_once(*args):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError('interrupted_after_ack')
            return original(*args)

        with patch.object(module, 'save_checkpoint', interrupt_once):
            with self.assertRaisesRegex(RuntimeError, 'interrupted_after_ack'):
                module.import_snapshot(options, client, Embedder())
        first_count = client.count('cbs-projeto-a_claude_mem_raw', exact=True).count
        self.assertEqual(first_count, 1)
        module.import_snapshot(options, client, Embedder())
        final_count = client.count('cbs-projeto-a_claude_mem_raw', exact=True).count
        self.assertGreater(final_count, first_count)
        self.assertEqual(module.import_snapshot(options, client, Embedder()), 0)
        self.assertEqual(client.count('cbs-projeto-a_claude_mem_raw', exact=True).count, final_count)
        anchor = client.scroll('cbs-projeto-a_claude_mem_raw', with_payload=True, limit=100)[0]
        selected = next(point for point in anchor if point.payload.get('source_id') == 1
                        and 'raw_row' in point.payload)
        row = module.read_raw(client, 'cbs-projeto-a_claude_mem_raw', selected.id)
        self.assertEqual(row['row']['text'], 'Olá memória')
        with self.assertRaisesRegex(ValueError, 'raw_anchor_not_found'):
            module.read_raw(client, 'other_claude_mem_raw', selected.id)
        client.close()

    def test_resume_from_mid_row_skips_acknowledged_chunks_and_advances_absolute_cursor(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        options = self.options(out, batch_size=1)
        items = [json.loads(line) for line in out.read_text().splitlines()]
        first_row = module.points_for_row(items[0], module.CharacterTokenizer())
        self.assertEqual(len(first_row), 2)
        identity = module.import_identity(options, module.snapshot_mapping(out))
        module.save_checkpoint(options.checkpoint, module.snapshot_digest(out), 0, 1, identity)
        client = QdrantClient(':memory:')
        self.assertEqual(module.import_snapshot(options, client, self.fake_embedder()), 3)
        name = 'cbs-projeto-a_claude_mem_raw'
        self.assertEqual(client.count(name, exact=True).count, 3)
        self.assertEqual(client.retrieve(name, ids=[first_row[0]['id']]), [])
        checkpoint = json.loads(Path(options.checkpoint).read_text())
        self.assertEqual((checkpoint['line'], checkpoint['offset']), (2, 0))
        client.close()

    def test_resume_from_next_line_skips_preceding_rows(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        options = self.options(out, batch_size=1)
        identity = module.import_identity(options, module.snapshot_mapping(out))
        module.save_checkpoint(options.checkpoint, module.snapshot_digest(out), 1, 0, identity)
        client = QdrantClient(':memory:')
        self.assertEqual(module.import_snapshot(options, client, self.fake_embedder()), 2)
        self.assertEqual(client.count('cbs-projeto-a_claude_mem_raw', exact=True).count, 2)
        client.close()

    def test_resume_mid_row_after_ack_reconciles_uncertain_next_chunk(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        options = self.options(out, batch_size=1)
        client = QdrantClient(':memory:')
        original = module.save_checkpoint
        calls = 0

        def interrupt_after_second_ack(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError('interrupted_after_second_ack')
            return original(*args)

        with patch.object(module, 'save_checkpoint', interrupt_after_second_ack):
            with self.assertRaisesRegex(RuntimeError, 'interrupted_after_second_ack'):
                module.import_snapshot(options, client, self.fake_embedder())
        checkpoint = json.loads(Path(options.checkpoint).read_text())
        self.assertEqual((checkpoint['line'], checkpoint['offset']), (0, 1))
        self.assertEqual(client.count('cbs-projeto-a_claude_mem_raw', exact=True).count, 2)
        self.assertEqual(module.import_snapshot(options, client, self.fake_embedder()), 2)
        self.assertEqual(client.count('cbs-projeto-a_claude_mem_raw', exact=True).count, 4)
        client.close()

    def test_resume_rejects_cursor_outside_snapshot_before_remote_write(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        options = self.options(out)
        identity = module.import_identity(options, module.snapshot_mapping(out))
        module.save_checkpoint(options.checkpoint, module.snapshot_digest(out), 3, 0, identity)
        client = QdrantClient(':memory:')
        with self.assertRaisesRegex(ValueError, 'checkpoint_cursor_out_of_range'):
            module.import_snapshot(options, client, self.fake_embedder())
        module.save_checkpoint(options.checkpoint, module.snapshot_digest(out), 0, 3, identity)
        with self.assertRaisesRegex(ValueError, 'checkpoint_cursor_out_of_range'):
            module.import_snapshot(options, client, self.fake_embedder())
        self.assertFalse(client.collection_exists('cbs-projeto-a_claude_mem_raw'))
        client.close()

    def options(self, snapshot, **changes):
        model = self.root / 'model.onnx'
        tokenizer = self.root / 'tokenizer.json'
        model.write_bytes(b'fixed-e5-model')
        tokenizer.write_bytes(b'fixed-e5-tokenizer')
        values = dict(snapshot=str(snapshot), checkpoint=str(self.root / 'checkpoint.json'),
                      batch_size=64, url='https://qdrant.example.org:6333',
                      address='8.8.8.8', model=str(model), tokenizer=str(tokenizer))
        values.update(changes)
        return SimpleNamespace(**values)

    def raw_snapshot(self):
        out = self.root / 'snapshot.jsonl'
        module.snapshot(self.db, [{'source_project': 'Projeto-A',
                                  'collection': 'cbs-projeto-a_claude_mem_raw'}], out)
        return out

    def fake_embedder(self):
        class Embedder:
            tokenizer = module.CharacterTokenizer()
            calls = 0

            def embed(self, text, memory_action):
                self.calls += 1
                return [1.0] + [0.0] * 383

        return Embedder()

    def test_embedding_cache_uses_exact_text_and_returns_independent_vectors(self):
        class Embedder:
            calls = []

            def embed(self, value, action):
                self.calls.append((value, action))
                return [float(len(self.calls)), 0.0]

        embedder = Embedder()
        cache = module.EmbeddingCache(embedder, 2)
        first = cache.get('same')
        first[0] = 99.0
        self.assertEqual(cache.get('same'), [1.0, 0.0])
        self.assertEqual(cache.get('Same'), [2.0, 0.0])
        cache.get('other')
        self.assertEqual(cache.get('same'), [4.0, 0.0])
        self.assertEqual(embedder.calls, [('same', 'add'), ('Same', 'add'),
                                          ('other', 'add'), ('same', 'add')])

    def test_embedding_cache_evicts_after_4096_distinct_texts(self):
        class Embedder:
            calls = 0

            def embed(self, value, action):
                self.calls += 1
                return [float(self.calls)]

        embedder = Embedder()
        cache = module.EmbeddingCache(embedder)
        for index in range(4097):
            cache.get(f'text {index}')
        self.assertEqual(cache.get('text 1'), [2.0])
        self.assertEqual(cache.get('text 0'), [4098.0])

    def test_import_reuses_equal_chunk_embeddings_only_within_invocation(self):
        from qdrant_client import QdrantClient
        with sqlite3.connect(self.db) as db:
            db.execute('UPDATE observations SET facts=text WHERE id=1')
        out = self.raw_snapshot()
        client = QdrantClient(':memory:')
        embedder = self.fake_embedder()
        self.assertEqual(module.import_snapshot(self.options(out), client, embedder), 4)
        self.assertEqual(embedder.calls, 3)
        client.delete_collection('cbs-projeto-a_claude_mem_raw')
        self.assertEqual(module.import_snapshot(self.options(out), client, embedder), 4)
        self.assertEqual(embedder.calls, 6)
        client.close()

    def test_interleaved_collections_batch_by_global_point_window(self):
        from qdrant_client import QdrantClient
        out = self.root / 'interleaved.jsonl'
        first = 'cbs-projeto-a_claude_mem_raw'
        second = 'cbs-subprojeto_claude_mem_raw'
        rows = []
        for index in range(8):
            project, collection = ('Projeto-A', first) if index % 2 == 0 else \
                                  ('Projeto-A/subprojeto', second)
            rows.append({'source_project': project, 'source_table': 'observations',
                         'collection': collection,
                         'row': {'id': index + 1, 'memory_session_id': 's',
                                 'created_at': '2024', 'text': f'piece {index}'}})
        out.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        out.chmod(0o600)
        real = QdrantClient(':memory:')

        class CountingClient:
            retrieves = []
            upserts = []

            def __getattr__(self, name):
                return getattr(real, name)

            def retrieve(self, collection, ids, **kwargs):
                self.retrieves.append((collection, len(ids)))
                return real.retrieve(collection, ids, **kwargs)

            def upsert(self, collection, points, **kwargs):
                self.upserts.append((collection, len(points)))
                return real.upsert(collection, points, **kwargs)

        client = CountingClient()
        self.assertEqual(module.import_snapshot(self.options(out, batch_size=8), client,
                                                self.fake_embedder()), 8)
        self.assertEqual(client.retrieves, [(first, 4), (second, 4)])
        self.assertEqual(client.upserts, [(first, 4), (second, 4)])
        real.close()

    def test_completed_checkpoint_rejects_changed_destination_before_key_or_network(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        options = self.options(out)
        client = QdrantClient(':memory:')
        module.import_snapshot(options, client, self.fake_embedder())
        with patch.object(module, 'client_for', side_effect=AssertionError('key_or_network')):
            with self.assertRaisesRegex(ValueError, 'checkpoint_identity_mismatch'):
                module.import_snapshot(self.options(out, address='1.1.1.1'),
                                       embedder=self.fake_embedder())
        client.close()

    def test_completed_checkpoint_repairs_deleted_collection_and_missing_point(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        options = self.options(out)
        client = QdrantClient(':memory:')
        embedder = self.fake_embedder()
        count = module.import_snapshot(options, client, embedder)
        name = 'cbs-projeto-a_claude_mem_raw'
        self.assertGreater(count, 1)
        all_ids = [str(p.id) for p in client.scroll(name, limit=100)[0]]
        from qdrant_client.models import PointIdsList
        client.delete(name, PointIdsList(points=[all_ids[0]]), wait=True)
        calls = embedder.calls
        self.assertEqual(module.import_snapshot(options, client, embedder), 1)
        self.assertEqual(embedder.calls - calls, 1)
        self.assertEqual(client.count(name, exact=True).count, count)
        client.delete_collection(name)
        self.assertEqual(module.import_snapshot(options, client, embedder), count)
        self.assertEqual(client.count(name, exact=True).count, count)
        client.close()

    def test_metadata_change_updates_anchor_without_reembedding_or_duplicate(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        options = self.options(out)
        client = QdrantClient(':memory:')
        embedder = self.fake_embedder()
        module.import_snapshot(options, client, embedder)
        name = 'cbs-projeto-a_claude_mem_raw'
        before = client.count(name, exact=True).count
        calls = embedder.calls
        with sqlite3.connect(self.db) as db:
            db.execute('ALTER TABLE observations ADD COLUMN relevance_count INTEGER')
            db.execute('UPDATE observations SET relevance_count=17 WHERE id=1')
        newer = self.root / 'newer.jsonl'
        module.snapshot(self.db, [{'source_project': 'Projeto-A', 'collection': name}], newer)
        self.assertEqual(module.import_snapshot(self.options(newer, checkpoint=str(
            self.root / 'newer-checkpoint.json')), client, embedder), 0)
        self.assertEqual(client.count(name, exact=True).count, before)
        self.assertEqual(embedder.calls, calls)
        anchors = [p for p in client.scroll(name, limit=100)[0] if p.payload.get('raw_row', {}).get('id') == 1]
        self.assertEqual(len(anchors), 1)
        self.assertEqual(anchors[0].payload['raw_row']['relevance_count'], 17)
        client.close()

    def test_shortened_text_removes_only_owned_obsolete_chunks(self):
        from qdrant_client import QdrantClient
        from qdrant_client.models import PointStruct
        name = 'cbs-projeto-a_claude_mem_raw'
        with sqlite3.connect(self.db) as db:
            db.execute('UPDATE observations SET text=? WHERE id=1', ('long text ' * 200,))
        out = self.raw_snapshot()
        client = QdrantClient(':memory:')
        embedder = self.fake_embedder()
        module.import_snapshot(self.options(out), client, embedder)
        before = [p for p in client.scroll(name, limit=100)[0] if p.payload.get('source_id') == 1]
        self.assertGreater(len(before), 1)
        foreign_id = 'afc95876-b8d8-4d49-898e-2af606b757d1'
        client.upsert(name, [PointStruct(id=foreign_id, vector=[1.0] + [0.0] * 383,
                                         payload={'source': 'other'})], wait=True)
        with sqlite3.connect(self.db) as db:
            db.execute('UPDATE observations SET text=? WHERE id=1', ('short',))
        newer = self.root / 'shorter.jsonl'
        module.snapshot(self.db, [{'source_project': 'Projeto-A', 'collection': name}], newer)
        module.import_snapshot(self.options(newer, checkpoint=str(self.root / 'shorter-checkpoint.json')),
                               client, embedder)
        after = [p for p in client.scroll(name, limit=100)[0] if p.payload.get('source_id') == 1]
        self.assertLess(len(after), len(before))
        self.assertEqual(len([p for p in after if p.payload.get('field') == 'text']), 1)
        self.assertEqual(len(client.retrieve(name, ids=[foreign_id])), 1)
        client.close()

    def test_legacy_checkpoint_fails_closed_before_key_or_network(self):
        out = self.raw_snapshot()
        options = self.options(out)
        Path(options.checkpoint).write_text(json.dumps({'snapshot_sha256': module.snapshot_digest(out),
                                                         'line': 1, 'offset': 0}))
        Path(options.checkpoint).chmod(0o600)
        with patch.object(module, 'client_for', side_effect=AssertionError('key_or_network')):
            with self.assertRaisesRegex(ValueError, 'checkpoint_identity_required'):
                module.import_snapshot(options, embedder=self.fake_embedder())

    def test_changed_model_files_fail_checkpoint_before_key_or_network(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        options = self.options(out)
        client = QdrantClient(':memory:')
        module.import_snapshot(options, client, self.fake_embedder())
        Path(options.model).write_bytes(b'different-model')
        with patch.object(module, 'client_for', side_effect=AssertionError('key_or_network')):
            with self.assertRaisesRegex(ValueError, 'checkpoint_identity_mismatch'):
                module.import_snapshot(options, embedder=self.fake_embedder())
        client.close()

    def test_existing_foreign_point_at_owned_id_fails_without_overwrite(self):
        from qdrant_client import QdrantClient
        from qdrant_client.models import PointStruct
        out = self.raw_snapshot()
        options = self.options(out)
        client = QdrantClient(':memory:')
        name = 'cbs-projeto-a_claude_mem_raw'
        module.ensure_raw_collection(client, name)
        first = json.loads(out.read_text().splitlines()[0])
        identifier = module.points_for_row(first, module.CharacterTokenizer())[0]['id']
        client.upsert(name, [PointStruct(id=identifier, vector=[1.0] + [0.0] * 383,
                                         payload={'source': 'foreign'})], wait=True)
        with self.assertRaisesRegex(ValueError, 'raw_point_ownership_mismatch'):
            module.import_snapshot(options, client, self.fake_embedder())
        self.assertEqual(client.retrieve(name, ids=[identifier])[0].payload,
                         {'source': 'foreign'})
        client.close()

    def test_stale_point_embedding_fingerprint_is_reembedded(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        options = self.options(out)
        client = QdrantClient(':memory:')
        embedder = self.fake_embedder()
        module.import_snapshot(options, client, embedder)
        name = 'cbs-projeto-a_claude_mem_raw'
        point = client.scroll(name, limit=100)[0][0]
        stale = dict(point.payload, embedding_fingerprint='old-e5')
        client.overwrite_payload(name, stale, [point.id], wait=True)
        calls = embedder.calls
        self.assertEqual(module.import_snapshot(options, client, embedder), 1)
        self.assertEqual(embedder.calls - calls, 1)
        self.assertNotEqual(client.retrieve(name, ids=[point.id])[0].payload['embedding_fingerprint'],
                            'old-e5')
        client.close()

    def test_adjacent_rows_share_retrieve_and_upsert_with_bounded_point_batch(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        real = QdrantClient(':memory:')

        class CountingClient:
            retrieves = []
            upserts = []

            def __getattr__(self, name):
                return getattr(real, name)

            def retrieve(self, collection, ids, **kwargs):
                self.retrieves.append((collection, list(ids)))
                return real.retrieve(collection, ids, **kwargs)

            def upsert(self, collection, points, **kwargs):
                self.upserts.append((collection, [point.id for point in points]))
                return real.upsert(collection, points, **kwargs)

        client = CountingClient()
        count = module.import_snapshot(self.options(out, batch_size=3), client,
                                       self.fake_embedder())
        self.assertEqual(count, 4)
        self.assertEqual([len(ids) for _, ids in client.upserts], [3, 1])
        self.assertEqual([len(ids) for _, ids in client.retrieves], [3, 1])
        self.assertEqual(real.count('cbs-projeto-a_claude_mem_raw', exact=True).count, 4)
        real.close()

    def test_ambiguous_upsert_timeout_retries_same_ids_without_duplicate(self):
        from qdrant_client import QdrantClient
        from qdrant_client.http.exceptions import ResponseHandlingException
        out = self.raw_snapshot()
        real = QdrantClient(':memory:')

        class AmbiguousClient:
            calls = []

            def __getattr__(self, name):
                return getattr(real, name)

            def upsert(self, collection, points, **kwargs):
                self.calls.append([point.id for point in points])
                result = real.upsert(collection, points, **kwargs)
                if len(self.calls) == 1:
                    raise ResponseHandlingException(httpx.ReadTimeout('response_lost'))
                return result

        client = AmbiguousClient()
        count = module.import_snapshot(self.options(out, batch_size=2), client,
                                       self.fake_embedder())
        self.assertEqual(count, 4)
        self.assertEqual(client.calls[0], client.calls[1])
        self.assertEqual(real.count('cbs-projeto-a_claude_mem_raw', exact=True).count, 4)
        self.assertEqual(json.loads(Path(self.options(out).checkpoint).read_text())['line'], 2)
        real.close()

    def test_partial_window_ack_does_not_advance_checkpoint_and_replays_all_ids(self):
        from qdrant_client import QdrantClient
        out = self.raw_snapshot()
        real = QdrantClient(':memory:')
        original = module.save_checkpoint
        writes = 0

        def fail_second_checkpoint(*args):
            nonlocal writes
            writes += 1
            if writes == 2:
                raise RuntimeError('crash_after_second_window_ack')
            return original(*args)

        with patch.object(module, 'save_checkpoint', fail_second_checkpoint):
            with self.assertRaisesRegex(RuntimeError, 'crash_after_second_window_ack'):
                module.import_snapshot(self.options(out, batch_size=2), real,
                                       self.fake_embedder())
        checkpoint = json.loads(Path(self.options(out).checkpoint).read_text())
        self.assertEqual((checkpoint['line'], checkpoint['offset']), (1, 0))
        self.assertEqual(real.count('cbs-projeto-a_claude_mem_raw', exact=True).count, 4)
        self.assertEqual(module.import_snapshot(self.options(out, batch_size=2), real,
                                                self.fake_embedder()), 0)
        self.assertEqual(real.count('cbs-projeto-a_claude_mem_raw', exact=True).count, 4)
        real.close()

    def test_failed_ack_in_second_collection_replays_without_advancing_checkpoint(self):
        from qdrant_client import QdrantClient
        out = self.root / 'multiple.jsonl'
        first = 'cbs-projeto-a_claude_mem_raw'
        second = 'cbs-subprojeto_claude_mem_raw'
        module.snapshot(self.db, [
            {'source_project': 'Projeto-A', 'collection': first},
            {'source_project': 'Projeto-A/subprojeto', 'collection': second},
        ], out)
        real = QdrantClient(':memory:')

        class IncompleteClient:
            failed = False

            def __getattr__(self, name):
                return getattr(real, name)

            def upsert(self, collection, points, **kwargs):
                result = real.upsert(collection, points, **kwargs)
                if collection == second and not self.failed:
                    self.failed = True
                    return SimpleNamespace(status='acknowledged')
                return result

        options = self.options(out, batch_size=3)
        with self.assertRaisesRegex(RuntimeError, 'upsert_not_acknowledged'):
            module.import_snapshot(options, IncompleteClient(), self.fake_embedder())
        self.assertFalse(Path(options.checkpoint).exists())
        self.assertEqual(real.count(first, exact=True).count, 2)
        self.assertEqual(real.count(second, exact=True).count, 1)
        self.assertEqual(module.import_snapshot(options, real, self.fake_embedder()), 2)
        self.assertEqual(real.count(first, exact=True).count, 4)
        self.assertEqual(real.count(second, exact=True).count, 1)
        real.close()

    def test_snapshot_tamper_rejected_before_key_or_network(self):
        out = self.raw_snapshot()
        options = self.options(out)
        from qdrant_client import QdrantClient
        real = QdrantClient(':memory:')
        module.import_snapshot(options, real, self.fake_embedder())
        out.write_text(out.read_text().replace('Olá memória', 'Oi memória'))
        with patch.object(module, 'client_for', side_effect=AssertionError('key_or_network')):
            with self.assertRaisesRegex(ValueError, 'checkpoint_snapshot_mismatch'):
                module.import_snapshot(options, embedder=self.fake_embedder())
        real.close()

    def test_public_client_sets_explicit_rest_timeout(self):
        options = self.options(self.raw_snapshot(), api_key_file=str(self.root / 'key'))
        with patch.object(module, 'safe_key', return_value='private-token'), \
                patch('mem0_adapter.PinnedTransport') as transport, \
                patch('qdrant_client.QdrantClient') as constructor:
            module.client_for(options)
        self.assertEqual(constructor.call_args.kwargs['timeout'], 30)
        self.assertIs(constructor.call_args.kwargs['transport'], transport.return_value)

    def test_transport_retry_is_bounded_and_validation_is_not_retried(self):
        attempts = 0

        def timeout():
            nonlocal attempts
            attempts += 1
            raise httpx.ReadTimeout('still_unavailable')

        with patch.object(module.time, 'sleep') as sleep:
            with self.assertRaises(httpx.ReadTimeout):
                module.retry_transport(timeout)
        self.assertEqual(attempts, 3)
        self.assertEqual(sleep.call_count, 2)
        attempts = 0

        def validation():
            nonlocal attempts
            attempts += 1
            raise ValueError('invalid_request')

        with self.assertRaisesRegex(ValueError, 'invalid_request'):
            module.retry_transport(validation)
        self.assertEqual(attempts, 1)

    def test_ensure_retries_transient_read_timeout(self):
        from qdrant_client import QdrantClient
        real = QdrantClient(':memory:')
        name = 'cbs-retry_claude_mem_raw'

        class TimeoutClient:
            reads = 0

            def __getattr__(self, key):
                return getattr(real, key)

            def get_collection(self, collection):
                self.reads += 1
                if self.reads == 1:
                    raise httpx.ReadTimeout('temporary')
                return real.get_collection(collection)

        client = TimeoutClient()
        with patch.object(module.time, 'sleep'):
            module.ensure_raw_collection(client, name)
        self.assertTrue(real.collection_exists(name))
        self.assertGreaterEqual(client.reads, 2)
        real.close()

    def test_ensure_recovers_ambiguous_create_timeout_and_validates_marker(self):
        from qdrant_client import QdrantClient
        real = QdrantClient(':memory:')
        name = 'cbs-retry_claude_mem_raw'

        class TimeoutClient:
            creates = 0

            def __getattr__(self, key):
                return getattr(real, key)

            def create_collection(self, **kwargs):
                self.creates += 1
                real.create_collection(**kwargs)
                raise httpx.ReadTimeout('response_lost')

        client = TimeoutClient()
        with patch.object(module.time, 'sleep'):
            module.ensure_raw_collection(client, name)
        self.assertEqual(client.creates, 1)
        self.assertTrue(real.collection_exists(name))
        real.close()

    def test_ensure_does_not_retry_auth_failure(self):
        from qdrant_client import QdrantClient
        real = QdrantClient(':memory:')
        name = 'cbs-retry_claude_mem_raw'

        class AuthClient:
            reads = 0

            def __getattr__(self, key):
                return getattr(real, key)

            def get_collection(self, collection):
                self.reads += 1
                raise httpx.HTTPStatusError('unauthorized', request=httpx.Request('GET',
                    'https://qdrant.example.org/collections'), response=httpx.Response(401))

        client = AuthClient()
        with self.assertRaises(httpx.HTTPStatusError):
            module.ensure_raw_collection(client, name)
        self.assertEqual(client.reads, 1)
        real.close()


if __name__ == '__main__':
    unittest.main()
