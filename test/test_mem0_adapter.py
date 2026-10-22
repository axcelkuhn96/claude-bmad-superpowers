import importlib.util
import io
import math
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

MODULE = Path(__file__).resolve().parents[1] / 'base/memoria/python/mem0_adapter.py'
spec = importlib.util.spec_from_file_location('mem0_adapter', MODULE)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTest(unittest.TestCase):
    def test_generated_context_requires_qualified_ref_hash_and_is_optional(self):
        refs = [{'message_id': 'u1', 'origin': 'human', 'source_text_sha256': 'a' * 64,
                 'excerpt': 'Use tenant filters.'},
                {'message_id': 'a1', 'origin': 'assistant', 'source_text_sha256': 'b' * 64,
                 'excerpt': 'Filters applied.'}]
        context = {'version': 1, 'items': [{'kind': 'reason',
                   'summary': 'Tenant isolation was required.',
                   'source_message_ids': ['u1', 'a1']}],
                   'trust': 'generated_unverified',
                   'source_refs_sha256': adapter.hashlib.sha256(adapter.json.dumps(
                       refs, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}
        self.assertTrue(adapter._valid_generated_context(context, refs))
        self.assertFalse(adapter._valid_generated_context(context, list(reversed(refs))))
        bad = {**context, 'items': [{**context['items'][0],
               'source_message_ids': ['invented']}]}
        self.assertFalse(adapter._valid_generated_context(bad, refs))
        self.assertFalse(adapter._valid_generated_context({**context, 'trust': 'verified'}, refs))
        self.assertFalse(adapter._valid_generated_context({**context, 'items': [
            {**context['items'][0], 'summary': 'é' * 129}]}, refs))

    def test_lexical_requires_literal_identifier_and_curated_identity(self):
        token = 'HML_TRIPEX_COMP'
        base = {'data': f'Usar {token} no teste', 'user_id': 'p', 'project_id': 'p',
                'status': 'active', 'source_record_id': 'source-1', 'scope': 'project',
                'source': 'message', 'actor': 'human', 'origin': 'user_direct',
                'speaker_role': 'user', 'evidence_at': '2026-10-21T12:00:00Z'}
        point = SimpleNamespace(id='00000000-0000-0000-0000-000000000001', payload=base)
        now = datetime(2026, 10, 22, tzinfo=timezone.utc)
        self.assertIsNotNone(adapter.validate_curated_payload(point, 'p', None, 'recall', now))
        for bad in ({'project_id': 'other'}, {'user_id': 'other'}, {'status': 'pending'},
                    {'scope': 'personal', 'owner_id': 'other'}, {'origin': 'imported_legacy'},
                    {'source_type': 'imported_legacy'},
                    {'format_version': 5, 'source': 'mcp_request:' + 'a' * 64,
                     'origin': 'assistant_report', 'speaker_role': 'assistant'},
                    {'data': 'Use HMLXTRIPEX_COMP'}):
            candidate = SimpleNamespace(id=point.id, payload={**base, **bad})
            if 'data' not in bad:
                self.assertIsNone(adapter.validate_curated_payload(candidate, 'p', None, 'recall', now))
        self.assertEqual(adapter.distinctive_tokens('servidor comum'), [])
        self.assertEqual(adapter.distinctive_tokens('HML_TRIPEX_COMP e ERR42'), [token, 'ERR42'])
        self.assertEqual(adapter.literal_spans('prefixHML_TRIPEX_COMP HML_TRIPEX_COMP2 HML_TRIPEX_COMP', token),
                         ['hml_tripex_comp'])

    def test_history_labels_expired_superseded_and_never_pending(self):
        base = {'data': 'ERR42', 'user_id': 'p', 'project_id': 'p',
                'source_record_id': 's', 'scope': 'episode', 'source': 'm', 'actor': 'human',
                'origin': 'user_direct', 'speaker_role': 'user', 'evidence_at': '2026-10-20T00:00:00Z',
                'valid_to': '2026-10-21T00:00:00Z'}
        point = SimpleNamespace(id='00000000-0000-0000-0000-000000000001', payload={**base, 'status': 'active'})
        now = datetime(2026, 10, 22, tzinfo=timezone.utc)
        self.assertIsNone(adapter.validate_curated_payload(point, 'p', None, 'recall', now))
        self.assertEqual(adapter.validate_curated_payload(point, 'p', None, 'history', now)['historyState'], 'expired')
        point.payload['status'] = 'superseded'
        self.assertEqual(adapter.validate_curated_payload(point, 'p', None, 'history', now)['historyState'], 'superseded')
        point.payload['status'] = 'pending'
        self.assertIsNone(adapter.validate_curated_payload(point, 'p', None, 'history', now))

    def test_lexical_ranks_verified_payload_not_scroll_order(self):
        base = {'user_id': 'p', 'project_id': 'p', 'status': 'active', 'source_record_id': 's',
                'scope': 'project', 'source': 'm', 'actor': 'human', 'origin': 'user_direct',
                'speaker_role': 'user', 'evidence_at': '2026-10-21T12:00:00Z'}
        points = [SimpleNamespace(id=f'00000000-0000-0000-0000-{i:012d}', payload={**base, 'data': text})
                  for i, text in ((1, 'HML_TRIPEX_COMP'), (2, 'HML_TRIPEX_COMP ERR42'),
                                  (3, 'HML_TRIPEX_COMP2'), (4, 'HML_TRIPEX_COMP'))]
        points[3].payload['project_id'] = 'other'
        class Client:
            def get_collection(self, collection):
                return SimpleNamespace(payload_schema={'data': SimpleNamespace(data_type='text')})
            def scroll(self, **kwargs):
                self_test.assertFalse(kwargs['with_vectors'])
                return points, None
        self_test = self
        result = adapter.lexical_candidates(Client(), 'c', 'p', 'HML_TRIPEX_COMP ERR42')
        self.assertEqual(result['kind'], 'items')
        self.assertEqual([row['sdkId'] for row in result['items']], [str(points[1].id), str(points[0].id)])
        self.assertEqual(result['items'][0]['retrievalEvidence']['literalSpans'], ['hml_tripex_comp', 'err42'])

    def test_index_text_admin_does_not_initialize_mem0(self):
        class Client:
            indexed = False
            def get_collection(self, collection):
                return SimpleNamespace(payload_schema={'data': SimpleNamespace(data_type='text')} if self.indexed else {},
                    config=SimpleNamespace(params=SimpleNamespace(vectors=SimpleNamespace(size=384, distance='Cosine')),
                                           metadata={'cbs_embedding_fingerprint': adapter.FINGERPRINT}))
            def create_payload_index(self, **kwargs):
                self_test.assertEqual((kwargs['collection_name'], kwargs['field_name']), ('c', 'data'))
                self.indexed = True
        self_test = self
        client = Client()
        with patch.object(adapter, '_memory', side_effect=AssertionError('mem0 loaded')):
            self.assertEqual(adapter.execute({'op': 'index_text', 'collection': 'c',
                'projectId': 'p', 'connection': {}}, client, Path('/tmp'))['created'], True)
            self.assertEqual(adapter.execute({'op': 'index_text', 'collection': 'c',
                'projectId': 'p', 'connection': {}}, client, Path('/tmp'))['created'], False)

    def test_vector_failure_admits_only_verified_lexical_or_unavailable(self):
        class Memory:
            embedding_model = object()
            def search(self, *args, **kwargs):
                raise OSError('vector unavailable')
        request = {'op': 'search', 'collection': 'c', 'projectId': 'p',
                   'connection': {}, 'query': 'ERR42'}
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()), \
             patch.object(adapter, 'lexical_candidates', return_value={'kind': 'items', 'items':
                 [{'sdkId': 'one', 'scoreSource': 'lexical_verified',
                   'retrievalEvidence': {'literalSpans': ['err42']}}]}):
            result = adapter.execute(request, object(), Path('/tmp'))
            self.assertEqual(result['kind'], 'items')
            self.assertEqual(result['items'], [])
            self.assertEqual(result['vector_degradation'], 'vector_unavailable')
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()), \
             patch.object(adapter, 'lexical_candidates', return_value={'kind': 'vector_only',
                                                                       'items': [], 'reason': 'index_missing'}):
            result = adapter.execute(request, object(), Path('/tmp'))
            self.assertEqual(result['kind'], 'unavailable')

    def test_lexical_index_absence_saturation_and_network_are_typed(self):
        class Client:
            def __init__(self, schema=True, points=None, offset=None, error=False):
                self.schema, self.points, self.offset, self.error = schema, points or [], offset, error
            def get_collection(self, collection):
                return SimpleNamespace(payload_schema={'data': SimpleNamespace(data_type='text')} if self.schema else {})
            def scroll(self, **kwargs):
                if self.error:
                    raise OSError('offline')
                return self.points, self.offset
        for client, reason in ((Client(schema=False), 'index_missing'),
                               (Client(points=[SimpleNamespace(id=i, payload={}) for i in range(32)], offset=33), 'saturated'),
                               (Client(error=True), 'lexical_unavailable')):
            result = adapter.lexical_candidates(client, 'c', 'p', 'HML_TRIPEX_COMP')
            self.assertEqual(result['kind'], 'vector_only')
            self.assertEqual(result['reason'], reason)

    def _fake_e5(self, device, available, *, platform='linux', fail_create=(), fail_run=(),
                 effective=None):
        sessions = []
        preloads = []
        class Options:
            def __init__(self):
                self.entries = {}
                self.enable_mem_pattern = True
            def add_session_config_entry(self, name, value):
                self.entries[name] = value
        class Session:
            def __init__(self, model, *, sess_options, providers):
                self.provider = providers[0][0] if isinstance(providers[0], tuple) else providers[0]
                self.providers = providers
                self.options = sess_options
                self.preloads = list(preloads)
                sessions.append(self)
                if self.provider in fail_create:
                    raise RuntimeError('provider initialization failed')
            def get_providers(self):
                if self.provider == effective:
                    return ['CPUExecutionProvider']
                return [self.provider, 'CPUExecutionProvider']
            def disable_fallback(self):
                self.fallback_disabled = True
            def get_inputs(self):
                return [SimpleNamespace(name='input_ids'), SimpleNamespace(name='attention_mask')]
            def run(self, outputs, inputs):
                if self.provider in fail_run:
                    raise RuntimeError('provider inference failed')
                return [np.ones((1, len(inputs['input_ids'][0]), 384), dtype=np.float32)]
        tokenizer = SimpleNamespace(enable_truncation=lambda **kwargs: None,
                                    encode=lambda text: SimpleNamespace(ids=[1, 2], attention_mask=[1, 1]))
        fake_ort = SimpleNamespace(SessionOptions=Options, InferenceSession=Session,
                                   get_available_providers=lambda: available,
                                   preload_dlls=lambda **kwargs: preloads.append(kwargs),
                                   ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL='sequential'))
        fake_tokenizers = SimpleNamespace(Tokenizer=SimpleNamespace(from_file=lambda path: tokenizer))
        with patch.dict(sys.modules, {'onnxruntime': fake_ort, 'tokenizers': fake_tokenizers}), \
             patch.dict(os.environ, {'CBS_MEMORIA_MODEL': '/tmp/model.onnx',
                                     'CBS_MEMORIA_TOKENIZER': '/tmp/tokenizer.json',
                                     'CBS_MEMORIA_EMBEDDING_DEVICE': device}), \
             patch.object(sys, 'platform', platform), \
             patch.object(adapter, '_digest', side_effect=[adapter.MODEL_SHA256,
                                                            adapter.TOKENIZER_SHA256]):
            embedder = adapter.E5Embedder()
            vector = embedder.embed('fact', 'search')
        return embedder, vector, sessions

    def test_explicit_mcp_record_is_curated_with_honest_provenance(self):
        identifier = '64eef286-9f7e-4326-b137-5658f0286c46'
        text = 'Compilar no HML_TRIPEX_COMP antes da promoção do RPO.'
        metadata = {'scope': 'project', 'type': 'decision', 'origin': 'assistant_report',
                    'speaker_role': 'assistant', 'actor': 'mcp_agent',
                    'source': 'mcp_request:' + 'c' * 64,
                    'source_text_sha256': 'a' * 64, 'review_mode': 'explicit_mcp',
                    'auto_consent_hash': 'b' * 64, 'format_version': 5,
                    'evidence_at': '2026-10-01T00:00:00Z',
                    'condition': 'Somente após a promoção de RPO no HML_TRIPEX_COMP; '
                                 'nunca testar o REST antes da confirmação. ' * 5}
        metadata['dedup_key'] = adapter._dedup_key('project', metadata, text)
        row = {'projectId': 'project', 'status': 'active', 'text': text, 'metadata': metadata}
        memory = SimpleNamespace(embedding_model=object(), get=lambda _: {'id': identifier})
        request = {'op': 'readonly_get', 'collection': 'native', 'projectId': 'project',
                   'memoryId': identifier, 'source': 'curated', 'connection': {}}
        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=memory), \
             patch.object(adapter, '_row', side_effect=lambda *args: row):
            result = adapter.execute_readonly(request, None, Path('/tmp'))
            self.assertEqual(result['kind'], 'item')
            self.assertEqual(result['item']['provenance']['review_mode'], 'explicit_mcp')
            self.assertEqual(result['item']['provenance']['source_text_sha256'], 'a' * 64)
            self.assertEqual(result['item']['provenance']['condition'], metadata['condition'])
            row['metadata'] = {**metadata, 'source_text_sha256': 'bad'}
            self.assertEqual(adapter.execute_readonly(request, None, Path('/tmp'))['reason'],
                             'source_unavailable')

    def test_explicit_mcp_duplicate_reuses_v4_key_without_second_add(self):
        text = 'Compilar no HML_TRIPEX_COMP antes da promoção do RPO.'
        common = {'scope': 'project', 'type': 'decision', 'format_version': 5,
                  'source': 'mcp_request:' + 'c' * 64,
                  'actor': 'mcp_agent', 'origin': 'assistant_report',
                  'speaker_role': 'assistant', 'review_mode': 'explicit_mcp',
                  'source_text_sha256': 'a' * 64, 'auto_consent_hash': 'b' * 64,
                  'evidence_at': '2026-10-01T00:00:00Z'}
        common['dedup_key'] = adapter._dedup_key('project', common, text)
        identifier = '64eef286-9f7e-4326-b137-5658f0286c46'
        point = SimpleNamespace(id=identifier, payload={**common, 'project_id': 'project',
            'user_id': 'project', 'data': text, 'status': 'active', 'source_record_id': 'first'})
        class Client:
            def scroll(self, **kwargs):
                return ([point], None)
        request = {'op': 'add', 'collection': 'native', 'projectId': 'project',
                   'externalId': 'second', 'sessionId': 'mcp-request-v1:second',
                   'text': text, 'metadata': common, 'connection': {}}
        memory = SimpleNamespace(add=lambda *args, **kwargs: self.fail('duplicate reached add'))
        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=memory):
            result = adapter.execute(request, Client(), Path('/tmp'))
        self.assertEqual(result['kind'], 'duplicate')
        self.assertEqual(result['duplicateOf']['externalId'], 'first')
        self.assertIs(result['duplicateOf']['hasContext'], False)
        invalid = {**request, 'metadata': {**common, 'review_mode': 'automatic'}}
        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=memory):
            with self.assertRaisesRegex(ValueError, 'explicit_mcp_invalid'):
                adapter.execute(invalid, Client(), Path('/tmp'))

    def test_memory_config_uses_ephemeral_history_only_when_requested(self):
        class Qdrant:
            pass
        class Factory:
            provider_to_class = {}
        class MemoryConfig:
            def __init__(self, **kwargs):
                self.history_db_path = kwargs['history_db_path']
        fake = {
            'mem0_adapter': adapter,
            'mem0.configs.base': SimpleNamespace(MemoryConfig=MemoryConfig),
            'mem0.configs.llms.base': SimpleNamespace(BaseLlmConfig=object),
            'mem0.memory.main': SimpleNamespace(Memory=lambda config: config),
            'mem0.utils.factory': SimpleNamespace(EmbedderFactory=Factory, LlmFactory=Factory,
                                                  VectorStoreFactory=Factory),
            'mem0.vector_stores.qdrant': SimpleNamespace(Qdrant=Qdrant),
        }
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, fake):
            state = Path(directory)
            connection = {'hostname': 'localhost', 'port': 6333}
            self.assertEqual(adapter._memory(None, 'native', state, connection).history_db_path,
                             str(state / 'mem0' / 'history.db'))
            self.assertEqual(adapter._memory(None, 'native', state, connection,
                             history_db_path=':memory:').history_db_path, ':memory:')
            self.assertFalse((state / 'mem0' / 'history.db').exists())

    def test_curated_readonly_get_uses_ephemeral_history_and_preserves_existing_db(self):
        identifier = '64eef286-9f7e-4326-b137-5658f0286c46'
        class Memory:
            embedding_model = object()
            def get(self, memory_id):
                self_test.assertEqual(memory_id, identifier)
                return {'id': memory_id}
        self_test = self
        metadata = {'scope': 'project', 'origin': 'user_direct', 'speaker_role': 'user',
                    'source': 'message', 'actor': 'user', 'evidence_at': '2026-10-01T00:00:00Z'}
        row = {'projectId': 'project', 'status': 'active', 'text': 'Remembered fact', 'metadata': metadata}
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            history = state / 'mem0' / 'history.db'
            history.parent.mkdir()
            history.write_bytes(b'existing history')
            before = (history.read_bytes(), history.stat().st_mtime_ns)
            with patch.object(adapter, 'verify_collection'), \
                 patch.object(adapter, '_memory', return_value=Memory()) as memory, \
                 patch.object(adapter, '_row', return_value=row):
                result = adapter.execute_readonly({'op': 'readonly_get', 'collection': 'native',
                    'projectId': 'project', 'memoryId': identifier, 'source': 'curated',
                    'connection': {}}, None, state)
            self.assertEqual(result['item']['text'], 'Remembered fact')
            self.assertEqual(memory.call_args.kwargs['history_db_path'], ':memory:')
            self.assertEqual((history.read_bytes(), history.stat().st_mtime_ns), before)

    def test_curated_readonly_get_labels_conversation_summary_and_rejects_false_roles(self):
        identifier = '64eef286-9f7e-4326-b137-5658f0286c46'
        refs = [{'message_id': 'user-1', 'role': 'user', 'origin': 'human', 'actor': 'user',
                 'offsets': {'start': 0, 'end': 20}, 'source_text_sha256': 'a' * 64,
                 'excerpt': 'Use PostgreSQL.'},
                {'message_id': 'assistant-1', 'role': 'assistant', 'origin': 'assistant',
                 'actor': 'assistant', 'offsets': {'start': 21, 'end': 70},
                 'source_text_sha256': 'b' * 64, 'excerpt': 'I will use PostgreSQL.'}]
        metadata = {'scope': 'project', 'origin': 'conversation_summary',
                    'speaker_role': 'mixed', 'actor': 'conversation', 'format_version': 4,
                    'source_refs': refs, 'source': 'user-1', 'type': 'decision',
                    'source_offsets': refs[0]['offsets'],
                    'source_text_sha256': refs[0]['source_text_sha256'],
                    'evidence_at': '2026-10-01T00:00:00Z'}
        metadata['dedup_key'] = adapter._dedup_key('project', metadata, 'Conversation summary')
        metadata['context_generated'] = {'version': 1, 'trust': 'generated_unverified',
            'source_refs_sha256': adapter.hashlib.sha256(adapter.json.dumps(refs,
                ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'items': [{'kind': 'reason', 'summary': 'Durable storage was needed.',
                       'source_message_ids': ['user-1', 'assistant-1']}]}
        row = {'projectId': 'project', 'status': 'active', 'text': 'Conversation summary',
               'metadata': metadata}
        memory = SimpleNamespace(embedding_model=object(), get=lambda _: {'id': identifier})
        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=memory), \
             patch.object(adapter, '_row', side_effect=lambda *args: row):
            request = {'op': 'readonly_get', 'collection': 'native', 'projectId': 'project',
                       'memoryId': identifier, 'source': 'curated', 'connection': {}}
            result = adapter.execute_readonly(request, None, Path('/tmp'))
            self.assertEqual(result['item']['provenance']['origin'], 'conversation_summary')
            self.assertEqual(result['item']['provenance']['source_ref_count'], 2)
            self.assertEqual(result['item']['provenance']['context_generated']['trust'],
                             'generated_unverified')
            row['metadata'] = {**metadata, 'context_generated': {**metadata['context_generated'],
                'trust': 'verified'}}
            self.assertEqual(adapter.execute_readonly(request, None, Path('/tmp'))['kind'], 'item')
            self.assertNotIn('context_generated', adapter.execute_readonly(
                request, None, Path('/tmp'))['item']['provenance'])
            for secret in ('AKIA' + 'A' * 16, 'eyJabc.eyJdef.signature'):
                row['metadata'] = {**metadata, 'context_generated': {
                    **metadata['context_generated'], 'items': [{
                        **metadata['context_generated']['items'][0],
                        'summary': 'The reason included ' + secret + '.'}]}}
                result = adapter.execute_readonly(request, None, Path('/tmp'))
                self.assertEqual(result['kind'], 'item')
                self.assertEqual(result['item']['text'], 'Conversation summary')
                self.assertEqual(result['item']['provenance']['source_refs'], refs)
                self.assertNotIn('context_generated', result['item']['provenance'])
            row['metadata'] = {**metadata, 'speaker_role': 'user'}
            self.assertEqual(adapter.execute_readonly(request, None, Path('/tmp'))['reason'],
                             'source_unavailable')

    def test_v4_exact_duplicate_is_found_before_another_mem0_add(self):
        metadata = {'scope': 'project', 'owner_id': None, 'type': 'decision',
                    'condition': None, 'valid_from': None, 'valid_to': None,
                    'source': 'm1', 'actor': 'conversation', 'origin': 'conversation_summary',
                    'evidence_at': '2026-10-01T00:00:00Z', 'format_version': 4}
        text = 'Use PostgreSQL.'
        metadata['dedup_key'] = adapter._dedup_key('p', metadata, text)
        self.assertEqual(metadata['dedup_key'],
                         '97ea1f73c9937d6685e61d1278d867cedce8dd5f024b062475862a831d9ffcee')
        first_id = '64eef286-9f7e-4326-b137-5658f0286c46'
        point = SimpleNamespace(id=first_id, payload={**metadata, 'project_id': 'p',
            'user_id': 'p', 'data': text, 'source_record_id': 'src-first', 'status': 'active'})
        class Client:
            def scroll(self, **kwargs):
                constraints = {entry.key: entry.match.value for entry in kwargs['scroll_filter'].must}
                self_test.assertEqual(kwargs['with_vectors'], False)
                return ([point] if all(point.payload.get(key) == value
                        for key, value in constraints.items()) else [], None)
        self_test = self
        second = {'op': 'add', 'collection': 'native', 'projectId': 'p',
                  'externalId': 'src-second', 'sessionId': 'later', 'text': text,
                  'connection': {}, 'metadata': metadata}
        memory = SimpleNamespace(add=lambda *args, **kwargs: self.fail('duplicate reached Mem0.add'))
        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=memory):
            result = adapter.execute(second, Client(), Path('/tmp'))
        self.assertEqual(result['kind'], 'duplicate')
        self.assertEqual(result['duplicateOf']['sdkId'], first_id)
        self.assertEqual(result['duplicateOf']['externalId'], 'src-first')
        self.assertRegex(result['evidenceDigest'], r'^[a-f0-9]{64}$')
        self.assertEqual(adapter._find_duplicate(Client(), 'native',
            {**second, 'text': 'Do not use PostgreSQL.', 'metadata': {
                **metadata, 'dedup_key': adapter._dedup_key('p', metadata,
                    'Do not use PostgreSQL.')}})['kind'], 'clear')

    def test_v4_two_batches_store_one_point_then_preserve_changed_claim(self):
        points = []
        calls = []
        class Client:
            def scroll(self, **kwargs):
                constraints = {entry.key: entry.match.value for entry in kwargs['scroll_filter'].must}
                return ([point for point in points if all(point.payload.get(key) == value
                         for key, value in constraints.items())], None)
        class Memory:
            def add(self, text, *, user_id, run_id, metadata, infer):
                self_test.assertFalse(infer)
                calls.append(text)
                identifier = f'64eef286-9f7e-4326-b137-{len(calls):012d}'
                points.append(SimpleNamespace(id=identifier, payload={**metadata,
                    'user_id': user_id, 'data': text, 'run_id': run_id}))
                return {'results': [{'id': identifier}]}
        self_test = self
        client = Client()
        metadata = {'scope': 'project', 'owner_id': None, 'type': 'decision',
            'source': 'm1', 'actor': 'conversation', 'origin': 'conversation_summary',
            'evidence_at': '2026-10-01T00:00:00Z', 'format_version': 4}
        text = 'Use PostgreSQL.'
        metadata['dedup_key'] = adapter._dedup_key('p', metadata, text)
        first = {'op': 'add', 'collection': 'native', 'projectId': 'p',
            'externalId': 'src-first', 'sessionId': 'session-one', 'text': text,
            'connection': {}, 'metadata': metadata}
        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=Memory()):
            self.assertEqual(adapter.execute(first, client, Path('/tmp'))['kind'], 'pending')
            points[0].payload['status'] = 'active'
            second = {**first, 'externalId': 'src-second', 'sessionId': 'session-two'}
            self.assertEqual(adapter.execute(second, client, Path('/tmp'))['kind'], 'duplicate')
            negation = 'Do not use PostgreSQL.'
            third = {**second, 'externalId': 'src-third', 'text': negation,
                'metadata': {**metadata, 'dedup_key': adapter._dedup_key('p', metadata, negation)}}
            self.assertEqual(adapter.execute(third, client, Path('/tmp'))['kind'], 'pending')
        self.assertEqual(calls, [text, negation])
        self.assertEqual(len(points), 2)

    def test_search_uses_ephemeral_history_but_write_path_keeps_persistent_history(self):
        class Memory:
            embedding_model = object()
            def search(self, *args, **kwargs):
                return {'results': []}
            def get_all(self, **kwargs):
                return {'results': []}
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            with patch.object(adapter, 'verify_collection'), \
                 patch.object(adapter, '_memory', return_value=Memory()) as memory:
                result = adapter.execute({'op': 'search', 'collection': 'native',
                    'projectId': 'project', 'query': 'fact', 'connection': {}}, None, state)
                self.assertEqual(result['items'], [])
                self.assertEqual(memory.call_args.kwargs['history_db_path'], ':memory:')
                adapter.execute({'op': 'find', 'collection': 'native', 'projectId': 'project',
                    'externalId': 'item', 'connection': {}}, None, state)
                self.assertNotIn('history_db_path', memory.call_args.kwargs)

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
                                   get_available_providers=lambda: ['CPUExecutionProvider'],
                                   ExecutionMode=SimpleNamespace(ORT_SEQUENTIAL='sequential'))
        fake_tokenizers = SimpleNamespace(Tokenizer=SimpleNamespace(from_file=lambda path: tokenizer))
        with patch.dict(sys.modules, {'numpy': SimpleNamespace(), 'onnxruntime': fake_ort,
                                      'tokenizers': fake_tokenizers}), \
             patch.dict(os.environ, {'CBS_MEMORIA_MODEL': '/tmp/model.onnx',
                                     'CBS_MEMORIA_TOKENIZER': '/tmp/tokenizer.json',
                                     'CBS_MEMORIA_EMBEDDING_DEVICE': 'cpu'}), \
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

    def test_e5_auto_tries_cuda_then_uses_cpu_after_first_inference_failure(self):
        embedder, vector, sessions = self._fake_e5('auto',
            ['CUDAExecutionProvider', 'CPUExecutionProvider'], fail_run=('CUDAExecutionProvider',))
        self.assertEqual([session.provider for session in sessions],
                         ['CUDAExecutionProvider', 'CPUExecutionProvider'])
        self.assertTrue(sessions[0].fallback_disabled)
        self.assertEqual(sessions[0].preloads, [{'cuda': True, 'cudnn': True,
                                                 'msvc': True, 'directory': ''}])
        self.assertEqual(embedder.provider, 'CPUExecutionProvider')
        self.assertEqual(embedder.fallback_reason, 'provider_run_failed')
        self.assertEqual(len(vector), 384)
        self.assertAlmostEqual(sum(value * value for value in vector), 1.0, places=5)

    def test_e5_auto_skips_silent_cpu_downgrade_and_falls_through_to_directml_on_windows(self):
        embedder, _, sessions = self._fake_e5('auto',
            ['CUDAExecutionProvider', 'DmlExecutionProvider', 'CPUExecutionProvider'],
            platform='win32', effective='CUDAExecutionProvider')
        self.assertEqual([session.provider for session in sessions],
                         ['CUDAExecutionProvider', 'DmlExecutionProvider'])
        self.assertEqual(embedder.provider, 'DmlExecutionProvider')
        self.assertEqual(embedder.fallback_reason, 'provider_inactive')
        self.assertFalse(sessions[1].options.enable_mem_pattern)
        self.assertEqual(sessions[1].options.execution_mode, 'sequential')

    def test_e5_explicit_cpu_never_creates_gpu_session(self):
        embedder, _, sessions = self._fake_e5('cpu',
            ['CUDAExecutionProvider', 'DmlExecutionProvider', 'CPUExecutionProvider'])
        self.assertEqual([session.provider for session in sessions], ['CPUExecutionProvider'])
        self.assertEqual(embedder.provider, 'CPUExecutionProvider')
        self.assertIsNone(embedder.fallback_reason)

    def test_e5_explicit_directml_falls_back_when_session_creation_fails(self):
        embedder, _, sessions = self._fake_e5('directml',
            ['DmlExecutionProvider', 'CPUExecutionProvider'], platform='win32',
            fail_create=('DmlExecutionProvider',))
        self.assertEqual([session.provider for session in sessions],
                         ['DmlExecutionProvider', 'CPUExecutionProvider'])
        self.assertEqual(embedder.provider, 'CPUExecutionProvider')
        self.assertEqual(embedder.fallback_reason, 'provider_init_failed')

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
        raw['metadata']['context_generated'] = {'version': 1}
        payload['context_generated'] = {'version': 1}
        self.assertNotIn('context_generated', adapter._row(raw, client, 'collection', Embedder())['metadata'])
        payload['context_generated'] = {'version': 2}
        with self.assertRaisesRegex(ValueError, 'remote_context_unverified'):
            adapter._row(raw, client, 'collection', Embedder())
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
        self.assertEqual(result['items'][0]['retrievalEvidence'], {'vectorScore': .9, 'vectorRank': 1})

    def test_search_reuses_one_embedding_across_sdk_pages(self):
        calls = []
        bad = {'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': 'bad', 'metadata':
               {'source': 's', 'actor': 'a', 'scope': 'personal', 'owner_id': 'other'}}
        good = {'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': 'good', 'metadata':
                {'source': 's', 'actor': 'a', 'scope': 'project'}}
        class Embedder:
            def embed(self, text, action):
                calls.append((text, action))
                return [1.0] + [0.0] * 383
        class Memory:
            embedding_model = Embedder()
            def search(self, query, *, filters, top_k, threshold):
                self.embedding_model.embed(query, 'search')
                return {'results': ([bad] * 20 + [good])[:top_k]}
        memory = Memory()
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=memory), \
             patch.object(adapter, '_row', side_effect=lambda row, *args: row), \
             patch.object(adapter, 'lexical_candidates', return_value={'kind': 'vector_only',
                                                                       'reason': 'index_missing', 'items': []}):
            result = adapter.execute({'op': 'search', 'collection': 'c', 'projectId': 'p',
                                      'connection': {}, 'query': 'fact'}, None, Path('/tmp'))
            self.assertEqual(calls, [('fact', 'search')])
            self.assertIsInstance(memory.embedding_model, Embedder)
            adapter.execute({'op': 'search', 'collection': 'c', 'projectId': 'p',
                             'connection': {}, 'query': 'fact'}, None, Path('/tmp'))
        self.assertEqual([item['sdkId'] for item in result['items']], ['good'])
        self.assertEqual(calls, [('fact', 'search'), ('fact', 'search')])

    def test_search_checks_final_2048_page_for_eligible_vectors(self):
        embed_calls = []
        top_ks = []
        bad = {'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': 'bad', 'metadata':
               {'source': 's', 'actor': 'a', 'scope': 'personal', 'owner_id': 'other'}}
        good = [{'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': f'good-{i}', 'metadata':
                 {'source': 's', 'actor': 'a', 'scope': 'project'}} for i in range(20)]
        rows = [bad] * 1300 + good
        class Embedder:
            def embed(self, text, action):
                embed_calls.append((text, action))
                return [1.0] + [0.0] * 383
        class Memory:
            embedding_model = Embedder()
            def search(self, query, *, filters, top_k, threshold):
                self.embedding_model.embed(query, 'search')
                top_ks.append(top_k)
                return {'results': rows[:top_k]}
        memory = Memory()
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=memory), \
             patch.object(adapter, '_row', side_effect=lambda row, *args: row), \
             patch.object(adapter, 'lexical_candidates', return_value={'kind': 'items',
                 'items': [{'sdkId': 'lex', 'scoreSource': 'lexical_verified'}]}):
            result = adapter.execute({'op': 'search', 'collection': 'c', 'projectId': 'p',
                                      'connection': {}, 'query': 'fact'}, None, Path('/tmp'))
        self.assertEqual(top_ks, [20, 40, 80, 160, 320, 640, 1280, 2048])
        self.assertEqual(embed_calls, [('fact', 'search')])
        self.assertIsInstance(memory.embedding_model, Embedder)
        self.assertEqual([item['sdkId'] for item in result['items']], [f'good-{i}' for i in range(20)])
        self.assertEqual([item['retrievalEvidence']['vectorRank'] for item in result['items']],
                         list(range(1, 21)))
        self.assertNotIn('vector_degradation', result)

    def test_search_saturation_returns_verified_lexical_fallback(self):
        top_ks = []
        bad = {'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': 'bad', 'metadata':
               {'source': 's', 'actor': 'a', 'scope': 'personal', 'owner_id': 'other'}}
        class Memory:
            embedding_model = object()
            def search(self, query, *, filters, top_k, threshold):
                top_ks.append(top_k)
                return {'results': [bad] * top_k}
        lexical = {'kind': 'items', 'items': [{'sdkId': 'lex', 'scoreSource': 'lexical_verified',
                   'retrievalEvidence': {'literalSpans': ['err42']}}]}
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()), \
             patch.object(adapter, '_row', side_effect=lambda row, *args: row), \
             patch.object(adapter, 'lexical_candidates', return_value=lexical):
            result = adapter.execute({'op': 'search', 'collection': 'c', 'projectId': 'p',
                'connection': {}, 'query': 'ERR42'}, None, Path('/tmp'))
        self.assertEqual(result['kind'], 'items')
        self.assertEqual(result['items'], [])
        self.assertEqual(result['lexical_items'], lexical['items'])
        self.assertEqual(result['vector_degradation'], 'vector_saturated')
        self.assertEqual(top_ks, [20, 40, 80, 160, 320, 640, 1280, 2048])

    def test_search_saturation_preserves_partial_vector_prefix_without_lexical(self):
        bad = {'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': 'bad', 'metadata':
               {'source': 's', 'actor': 'a', 'scope': 'personal', 'owner_id': 'other'}}
        good = {'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': 'good', 'metadata':
                {'source': 's', 'actor': 'a', 'scope': 'project'}}
        rows = [bad] * 2047 + [good]
        class Memory:
            embedding_model = object()
            def search(self, query, *, filters, top_k, threshold):
                return {'results': rows[:top_k]}
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()), \
             patch.object(adapter, '_row', side_effect=lambda row, *args: row), \
             patch.object(adapter, 'lexical_candidates', return_value={
                 'kind': 'vector_only', 'reason': 'index_missing', 'items': []}):
            result = adapter.execute({'op': 'search', 'collection': 'c', 'projectId': 'p',
                'connection': {}, 'query': 'fact'}, None, Path('/tmp'))
        self.assertEqual(result['kind'], 'items')
        self.assertEqual([row['sdkId'] for row in result['items']], ['good'])
        self.assertEqual([row['retrievalEvidence']['vectorRank'] for row in result['items']], [1])
        self.assertEqual(result['vector_degradation'], 'vector_saturated')
        self.assertEqual(result['lexical_degradation'], 'index_missing')

    def test_search_saturation_preserves_nineteen_vectors_before_lexical(self):
        bad = {'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': 'bad', 'metadata':
               {'source': 's', 'actor': 'a', 'scope': 'personal', 'owner_id': 'other'}}
        good = [{'projectId': 'p', 'status': 'active', 'score': .9, 'sdkId': f'good-{i}', 'metadata':
                 {'source': 's', 'actor': 'a', 'scope': 'project'}} for i in range(19)]
        rows = [bad] * 2029 + good
        lexical = {'kind': 'items', 'items': [{'sdkId': 'lex', 'scoreSource': 'lexical_verified'}]}
        class Memory:
            embedding_model = object()
            def search(self, query, *, filters, top_k, threshold):
                return {'results': rows[:top_k]}
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()), \
             patch.object(adapter, '_row', side_effect=lambda row, *args: row), \
             patch.object(adapter, 'lexical_candidates', return_value=lexical):
            result = adapter.execute({'op': 'search', 'collection': 'c', 'projectId': 'p',
                'connection': {}, 'query': 'ERR42'}, None, Path('/tmp'))
        self.assertEqual(result['kind'], 'items')
        self.assertEqual([row['sdkId'] for row in result['items']], [f'good-{i}' for i in range(19)])
        self.assertEqual(result['lexical_items'], lexical['items'])
        self.assertEqual(result['vector_degradation'], 'vector_saturated')

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
            self.assertEqual(result['items'], [{**rows[2], 'scoreSource': 'mem0_sdk_search',
                                                'retrievalEvidence': {'vectorScore': .9, 'vectorRank': 1}}])

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
