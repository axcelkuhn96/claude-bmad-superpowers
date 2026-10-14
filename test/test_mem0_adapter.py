import importlib.util
import io
import math
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'base/memoria/python/mem0_adapter.py'
spec = importlib.util.spec_from_file_location('mem0_adapter', MODULE)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTest(unittest.TestCase):
    def test_e5_passes_bounded_options_to_onnx_without_loading_model(self):
        sessions = []
        class Options:
            def __init__(self):
                self.entries = {}
            def add_session_config_entry(self, name, value):
                self.entries[name] = value
        class Session:
            def __init__(self, model, *, sess_options, providers):
                sessions.append((model, sess_options, providers))
            def get_inputs(self):
                return []
        tokenizer = SimpleNamespace(enable_truncation=lambda **kwargs: None)
        fake_ort = SimpleNamespace(SessionOptions=Options, InferenceSession=Session,
                                   ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL='sequential'))
        fake_tokenizers = SimpleNamespace(Tokenizer=SimpleNamespace(from_file=lambda path: tokenizer))
        with patch.dict(sys.modules, {'numpy': SimpleNamespace(), 'onnxruntime': fake_ort,
                                      'tokenizers': fake_tokenizers}), \
             patch.dict(os.environ, {'CBS_MEMORIA_MODEL': '/tmp/model.onnx',
                                     'CBS_MEMORIA_TOKENIZER': '/tmp/tokenizer.json'}), \
             patch.object(adapter, '_digest', side_effect=[adapter.MODEL_SHA256, adapter.TOKENIZER_SHA256]):
            adapter.E5Embedder()
        self.assertEqual(len(sessions), 1)
        model, options, providers = sessions[0]
        self.assertEqual(model, '/tmp/model.onnx')
        self.assertEqual((options.intra_op_num_threads, options.inter_op_num_threads,
                          options.execution_mode), (2, 1, 'sequential'))
        self.assertEqual(options.entries, {'session.intra_op.allow_spinning': '0',
                                           'session.inter_op.allow_spinning': '0'})
        self.assertEqual(providers, ['CPUExecutionProvider'])

    def test_direct_entry_caps_inherited_threads_before_sdk_import(self):
        values_at_import = []
        class FakeQdrantModule:
            def __getattr__(self, name):
                if name != 'QdrantClient':
                    raise AttributeError(name)
                values_at_import.append(tuple(os.environ[key] for key in
                    ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS')))
                return lambda **kwargs: SimpleNamespace(close=lambda: None)
        inherited = {'OMP_NUM_THREADS': '64', 'OPENBLAS_NUM_THREADS': '64',
                     'MKL_NUM_THREADS': '64', 'CBS_MEMORIA_STATE': '/tmp/state',
                     'CBS_MEMORIA_API_KEY': 'private-secret'}
        output = io.StringIO()
        with patch.dict(os.environ, inherited), patch.dict(sys.modules, {'qdrant_client': FakeQdrantModule()}), \
             patch.object(sys, 'stdin', io.StringIO('{"connection": {}}\n')), \
             patch.object(sys, 'stdout', output), \
             patch.object(adapter, 'PinnedTransport', return_value=SimpleNamespace(close=lambda: None)), \
             patch.object(adapter, 'execute', return_value={'kind': 'items', 'items': []}):
            self.assertEqual(adapter.main(), 0)
            self.assertEqual(tuple(os.environ[key] for key in
                ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS')), ('2', '1', '1'))
        self.assertEqual(values_at_import, [('2', '1', '1')])
        self.assertNotIn('private-secret', output.getvalue())

    def test_e5_bounds_onnx_threads_and_returns_normalized_384d_vector(self):
        if not os.environ.get('CBS_MEMORIA_MODEL') or not os.environ.get('CBS_MEMORIA_TOKENIZER'):
            self.skipTest('pinned E5 artifacts not supplied')
        embedder = adapter.E5Embedder()
        options = embedder.session.get_session_options()
        self.assertEqual(options.intra_op_num_threads, 2)
        self.assertEqual(options.inter_op_num_threads, 1)
        import onnxruntime as ort
        self.assertEqual(options.execution_mode, ort.ExecutionMode.ORT_SEQUENTIAL)
        self.assertEqual(options.get_session_config_entry('session.intra_op.allow_spinning'), '0')
        self.assertEqual(options.get_session_config_entry('session.inter_op.allow_spinning'), '0')
        vector = embedder.embed('Uma memória curta.', 'search')
        self.assertEqual(len(vector), 384)
        self.assertTrue(all(math.isfinite(value) for value in vector))
        self.assertAlmostEqual(math.sqrt(sum(value * value for value in vector)), 1.0, places=5)

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

    def test_public_pin_requires_explicit_mode_and_keeps_tls_and_redirect_guards(self):
        import httpx
        pin = {'url': 'https://documentos.sigamina.com.br:48677/',
               'hostname': 'documentos.sigamina.com.br', 'address': '157.230.226.207',
               'port': 48677, 'protocol': 'https:', 'servername': 'documentos.sigamina.com.br'}
        with self.assertRaisesRegex(ValueError, 'destination'):
            adapter.PinnedTransport(pin)
        for bad in ('100.64.0.1', '169.254.169.254', '203.0.113.1',
                    '224.0.0.1', '10.0.0.1', '192.31.196.1',
                    '192.52.193.1', '192.175.48.1', '192.0.0.9'):
            with self.assertRaisesRegex(ValueError, 'destination'):
                adapter.PinnedTransport({**pin, 'address': bad, 'allowPublic': True})
        for bad in ('https://127.0.0.1:48677/', 'https://localhost:48677/',
                    'http://documentos.sigamina.com.br:48677/'):
            hostname = __import__('urllib.parse', fromlist=['urlsplit']).urlsplit(bad).hostname
            with self.assertRaisesRegex(ValueError, 'destination'):
                adapter.PinnedTransport({**pin, 'url': bad, 'hostname': hostname,
                                         'servername': hostname,
                                         'protocol': bad.split(':')[0] + ':', 'allowPublic': True})
        transport = adapter.PinnedTransport({**pin, 'allowPublic': True})
        try:
            self.assertIsInstance(transport.inner, httpx.HTTPTransport)
            class FakeInner:
                def handle_request(self, request):
                    self_test.assertEqual(request.url.host, '157.230.226.207')
                    self_test.assertEqual(request.extensions['sni_hostname'], pin['hostname'])
                    return httpx.Response(302, headers={'location': 'https://evil.example/'})
                def close(self):
                    pass
            self_test = self
            transport.inner.close()
            transport.inner = FakeInner()
            with self.assertRaisesRegex(ValueError, 'redirect'):
                transport.handle_request(httpx.Request('GET', pin['url'],
                    headers={'host': 'documentos.sigamina.com.br:48677'}))
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
        bad = {'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': 'bad', 'metadata':
               {'source': 's', 'actor': 'a', 'scope': 'personal', 'owner_id': 'other'}}
        good = {'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': 'good', 'metadata':
                {'source': 's', 'actor': 'a', 'scope': 'project'}}
        rows = [bad] * 25 + [good]
        self_test = self
        class Memory:
            embedding_model = object()
            def search(self, query, *, filters, top_k, threshold):
                self_test.assertEqual(threshold, .85)
                return {'results': rows[:top_k]}
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()), \
             patch.object(adapter, '_row', side_effect=lambda row, *args: row):
            result = adapter.execute({'op': 'search', 'collection': 'c', 'projectId': 'p',
                                      'connection': {}, 'query': 'fact'}, None, Path('/tmp'))
        self.assertEqual([row['sdkId'] for row in result['items']], ['good'])
        self.assertEqual(result['items'][0]['scoreSource'], 'mem0_sdk_search')

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

    def test_episode_requires_explicit_expiry_and_search_filters_project_and_time(self):
        expires = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        expired = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        metadata = {'source': 'message', 'actor': 'owner', 'origin': 'user_direct',
                    'scope': 'episode', 'evidence_at': '2026-09-30T12:00:00Z'}
        class Memory:
            embedding_model = object()
            def add(self, *args, **kwargs):
                self_test.assertEqual(kwargs['metadata']['scope'], 'episode')
                return {'results': [{'id': 'episode-id'}]}
            def search(self, query, *, filters, top_k, threshold):
                self_test.assertEqual(filters, {'user_id': 'p', 'status': 'active'})
                self_test.assertEqual(threshold, .85)
                return {'results': rows}
        self_test = self
        rows = [
            {'projectId': 'other', 'status': 'active', 'score': .9, 'metadata': {**metadata, 'valid_to': expires}},
            {'projectId': 'p', 'status': 'active', 'score': .9, 'metadata': {**metadata, 'valid_to': expired}},
            {'projectId': 'p', 'status': 'active', 'score': .9, 'metadata': {**metadata, 'valid_to': expires}},
        ]
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()), \
             patch.object(adapter, '_row', side_effect=lambda row, *args: row):
            request = {'op': 'add', 'collection': 'c', 'projectId': 'p', 'externalId': 'e',
                       'connection': {}, 'sessionId': 's', 'text': 'fact', 'metadata': metadata}
            with self.assertRaisesRegex(ValueError, 'scope_invalid'):
                adapter.execute(request, None, Path('/tmp'))
            self.assertEqual(adapter.execute({**request, 'metadata': {**metadata, 'valid_to': expires}},
                                             None, Path('/tmp'))['kind'], 'pending')
            result = adapter.execute({'op': 'search', 'collection': 'c', 'projectId': 'p',
                                      'connection': {}, 'query': 'fact'}, None, Path('/tmp'))
            self.assertEqual(result['items'], [{**rows[2], 'scoreSource': 'mem0_sdk_search'}])

    def test_readonly_raw_search_uses_only_derived_marked_collection(self):
        from uuid import uuid4
        anchor = str(uuid4())
        payload = {'source': 'claude-mem', 'source_type': 'imported_legacy',
                   'origin': 'assistant_report', 'speaker_role': 'assistant',
                   'collection': 'native_claude_mem_raw', 'anchor_id': anchor,
                   'embedding_fingerprint': adapter.FINGERPRINT, 'text': 'historical note',
                   'source_project': 'old-project', 'source_table': 'observations',
                   'source_id': 4, 'evidence_at': '2024-01-01T00:00:00Z'}
        class Client:
            def collection_exists(self, name):
                self_test.assertEqual(name, 'native_claude_mem_raw')
                return True
            def get_collection(self, name):
                return SimpleNamespace(config=SimpleNamespace(params=SimpleNamespace(vectors=SimpleNamespace(
                    size=384, distance='Cosine')), metadata={'cbs_embedding_fingerprint': adapter.FINGERPRINT,
                    'cbs_source': 'claude-mem-raw-v1'}))
            def query_points(self, name, *, query, limit, with_payload):
                self_test.assertEqual(name, 'native_claude_mem_raw')
                self_test.assertEqual(limit, 8)
                return SimpleNamespace(points=[SimpleNamespace(id=anchor, payload=payload, score=.82)])
        self_test = self
        with patch.object(adapter, '_WARM_EMBEDDER', SimpleNamespace(embed=lambda text, action: [0.0] * 384)):
            result = adapter.execute_readonly({'op': 'raw_search', 'collection': 'native',
                'projectId': 'project', 'query': 'note'}, Client(), Path('/tmp'))
        self.assertEqual(result['items'][0]['readId'], anchor)
        self.assertEqual(result['items'][0]['preview'], 'historical note')

    def test_readonly_raw_missing_collection_is_empty_and_foreign_anchor_is_denied(self):
        from uuid import uuid4
        anchor = str(uuid4())
        class Missing:
            def collection_exists(self, name):
                return False
        self.assertEqual(adapter.execute_readonly({'op': 'raw_search', 'collection': 'native',
            'projectId': 'project', 'query': 'note'}, Missing(), Path('/tmp'))['items'], [])
        class Foreign:
            def collection_exists(self, name):
                return True
            def get_collection(self, name):
                return SimpleNamespace(config=SimpleNamespace(params=SimpleNamespace(vectors=SimpleNamespace(
                    size=384, distance='Cosine')), metadata={'cbs_embedding_fingerprint': adapter.FINGERPRINT,
                    'cbs_source': 'claude-mem-raw-v1'}))
            def retrieve(self, name, *, ids, with_payload):
                return [SimpleNamespace(id=anchor, payload={'anchor_id': anchor,
                    'collection': 'foreign_claude_mem_raw', 'raw_row': {'secret': True}})]
        result = adapter.execute_readonly({'op': 'readonly_get', 'collection': 'native',
            'projectId': 'project', 'source': 'legacy', 'memoryId': anchor,
            'offset': 0}, Foreign(), Path('/tmp'))
        self.assertEqual(result['reason'], 'source_unavailable')


if __name__ == '__main__':
    unittest.main()
