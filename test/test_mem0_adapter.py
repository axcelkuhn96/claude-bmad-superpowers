import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'base/memoria/python/mem0_adapter.py'
spec = importlib.util.spec_from_file_location('mem0_adapter', MODULE)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTest(unittest.TestCase):
    def test_pin_rejects_other_destination_before_transport(self):
        pin = {'url': 'https://qdrant.fixture.invalid:6333/', 'hostname': 'qdrant.fixture.invalid',
               'address': '127.0.0.1', 'port': 6333, 'protocol': 'https:', 'servername': 'qdrant.fixture.invalid'}
        transport = adapter.PinnedTransport(pin)
        try:
            import httpx
            with self.assertRaisesRegex(ValueError, 'destination'):
                transport.handle_request(httpx.Request('GET', 'https://other.invalid:6333/collections',
                                                       headers={'host': 'other.invalid:6333'}))
        finally:
            transport.close()

    def test_missing_collection_does_not_create_collection(self):
        class FakeClient:
            def get_collection(self, name):
                raise RuntimeError('not found')
            def create_collection(self, **kwargs):
                raise AssertionError('created')
        with self.assertRaisesRegex(RuntimeError, 'not found'):
            adapter.verify_collection(FakeClient(), 'memories', 'fingerprint')

    def test_remote_vector_must_match_approved_text_before_verification(self):
        raw = {'id': 'uuid-1', 'memory': 'approved fact', 'user_id': 'p',
               'metadata': {'status': 'active', 'source_record_id': 'source-1'}}
        payload = {'data': 'approved fact', 'user_id': 'p', 'project_id': 'p',
                   'status': 'active', 'source_record_id': 'source-1'}
        expected = [1.0] + [0.0] * 383
        class Client:
            vector = expected
            def retrieve(self, *args, **kwargs):
                return [SimpleNamespace(id='uuid-1', vector=self.vector, payload=payload)]
        class Embedder:
            def embed(self, text, memory_action):
                self_test.assertEqual((text, memory_action), ('approved fact', 'add'))
                return expected
        self_test = self
        client = Client()
        self.assertEqual(adapter._row(raw, client, 'collection', Embedder())['status'], 'active')
        for vector in ([0.0] * 384, [0.0, 1.0] + [0.0] * 382):
            client.vector = vector
            with self.assertRaisesRegex(ValueError, 'remote_vector'):
                adapter._row(raw, client, 'collection', Embedder())
        client.vector = expected
        with self.assertRaisesRegex(ValueError, 'remote_expiration_unsupported'):
            adapter._row({**raw, 'expiration_date': '2025-01-01T00:00:00Z'}, client, 'collection', Embedder())

    def test_search_fetches_past_ineligible_items_before_limiting(self):
        bad = {'projectId': 'p', 'status': 'active', 'sdkId': 'bad', 'metadata':
               {'source': 's', 'actor': 'a', 'scope': 'personal', 'owner_id': 'other'}}
        good = {'projectId': 'p', 'status': 'active', 'sdkId': 'good', 'metadata':
                {'source': 's', 'actor': 'a', 'scope': 'project'}}
        rows = [bad] * 25 + [good]
        class Memory:
            embedding_model = object()
            def search(self, query, *, filters, top_k):
                return {'results': rows[:top_k]}
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()), \
             patch.object(adapter, '_row', side_effect=lambda row, *args: row):
            result = adapter.execute({'op': 'search', 'collection': 'c', 'projectId': 'p',
                                      'connection': {}, 'query': 'fact'}, None, Path('/tmp'))
        self.assertEqual([row['sdkId'] for row in result['items']], ['good'])

    def test_reconciliation_includes_expired_sdk_rows_and_rejects_expiration_on_add(self):
        class Memory:
            def get_all(self, **kwargs):
                self_test.assertTrue(kwargs.get('show_expired'))
                return {'results': []}
            def add(self, *args, **kwargs):
                self_test.fail('reserved expiration_date reached SDK add')
        self_test = self
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()):
            self.assertEqual(adapter.execute({'op': 'find', 'collection': 'c', 'projectId': 'p',
                                               'externalId': 'e', 'connection': {}}, None, Path('/tmp'))['items'], [])
            with self.assertRaisesRegex(ValueError, 'reserved_metadata'):
                adapter.execute({'op': 'add', 'collection': 'c', 'projectId': 'p', 'externalId': 'e',
                                 'connection': {}, 'sessionId': 's', 'text': 'fact',
                                 'metadata': {'expiration_date': '2025-01-01T00:00:00Z'}}, None, Path('/tmp'))


if __name__ == '__main__':
    unittest.main()
