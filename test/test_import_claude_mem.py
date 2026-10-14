import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


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
        options = SimpleNamespace(snapshot=str(out), checkpoint=str(self.root / 'checkpoint.json'),
                                  batch_size=1)
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


if __name__ == '__main__':
    unittest.main()
