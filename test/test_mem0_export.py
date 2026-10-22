import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'base/memoria/python/mem0_adapter.py'
spec = importlib.util.spec_from_file_location('mem0_adapter_export', MODULE)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def point(n, **extra):
    payload = {'data': 'safe fact', 'user_id': 'p', 'project_id': 'p', 'status': 'active',
               'source_record_id': 's', 'scope': 'project', 'source': 'm', 'actor': 'human',
               'origin': 'user_direct', 'speaker_role': 'user', 'evidence_at': '2026-10-20T00:00:00Z'}
    payload.update(extra)
    return SimpleNamespace(id=f'00000000-0000-0000-0000-{n:012d}', payload=payload)


class ExportTest(unittest.TestCase):
    def test_derived_export_cannot_be_accepted_as_remote_source(self):
        derived = point(1, source_type='derived_export')
        self.assertIsNone(adapter.validate_curated_payload(derived, 'p', None, 'history'))

    def test_derived_export_cannot_be_added_or_activated(self):
        request = {'op': 'add', 'collection': 'c', 'projectId': 'p', 'connection': {},
                   'metadata': {'source_type': 'derived_export', 'scope': 'project',
                                'source': 's', 'actor': 'human', 'origin': 'user_direct',
                                'evidence_at': '2026-10-20T00:00:00Z'},
                   'text': 'safe fact', 'sessionId': 'session', 'externalId': 's'}
        memory = SimpleNamespace(get=lambda _id: {}, embedding_model=object(),
                                 add=lambda *args, **kwargs: {'results': [{'id': 'id'}]})
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=memory):
            with self.assertRaisesRegex(ValueError, 'derived_source'):
                adapter.execute(request, object(), Path('/tmp'))
            request['op'] = 'activate'
            request['sdkId'] = 'id'
            request['externalId'] = 's'
            derived = {'projectId': 'p', 'externalId': 's', 'status': 'pending',
                       'metadata': {'source_type': 'derived_export'}}
            with patch.object(adapter, '_row', return_value=derived):
                with self.assertRaisesRegex(ValueError, 'derived_source'):
                    adapter.execute(request, object(), Path('/tmp'))

    def test_page_filters_owner_pending_legacy_and_requires_no_vectors(self):
        points = [point(1), point(2, scope='personal', owner_id='other'),
                  point(3, status='pending'), point(4, source_type='imported_legacy'),
                  point(5, project_id='other')]
        class Client:
            def scroll(self, **kwargs):
                self_test.assertEqual(kwargs['limit'], 64)
                self_test.assertFalse(kwargs['with_vectors'])
                return points, None
        self_test = self
        result = adapter.history_page(Client(), 'c', 'p', 'mine', None)
        self.assertEqual(result['kind'], 'page')
        self.assertEqual(result['scanned'], 5)
        self.assertEqual([r['qdrantId'] for r in result['items']], [str(points[0].id)])

    def test_page_rejects_oversized_response_and_retrieve_is_curated(self):
        class Client:
            def scroll(self, **kwargs):
                return [point(1, data='x' * (4 * 1024 * 1024))], None
            def retrieve(self, *args, **kwargs):
                self_test.assertFalse(kwargs['with_vectors'])
                return [point(1)]
        self_test = self
        with self.assertRaisesRegex(ValueError, 'page_oversized'):
            adapter.history_page(Client(), 'c', 'p', None, None)
        self.assertEqual(adapter.history_get(Client(), 'c', 'p', None,
            '00000000-0000-0000-0000-000000000001')['kind'], 'item')


if __name__ == '__main__':
    unittest.main()
