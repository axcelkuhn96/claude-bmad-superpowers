"""Opt-in integration test for a task-owned, authenticated Qdrant fixture."""

import importlib.util
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

MODULE = Path(__file__).resolve().parents[1] / 'base/memoria/python/mem0_adapter.py'
spec = importlib.util.spec_from_file_location('mem0_adapter', MODULE)
adapter = importlib.util.module_from_spec(spec)
sys.modules['mem0_adapter'] = adapter
spec.loader.exec_module(adapter)


@unittest.skipUnless(os.environ.get('CBS_TASK3_REMOTE_DIR'), 'isolated Qdrant fixture not configured')
class RemoteSDKTest(unittest.TestCase):
    def test_sdk_remote_faults_scope_and_correction(self):
        from qdrant_client import QdrantClient, models
        root = Path(os.environ['CBS_TASK3_REMOTE_DIR'])
        port = json.loads((root / 'meta.json').read_text())['port']
        key = (root / 'key').read_text()
        state = Path('/tmp/cbs-mem0-runtime-m002-validacao-20261001/state')
        home = Path(tempfile.mkdtemp(prefix='cbs-task3-home-'))
        self.addCleanup(lambda: __import__('shutil').rmtree(home))
        os.environ['HOME'] = str(home)
        os.environ['MEM0_DIR'] = str(state / 'mem0')
        os.environ['MEM0_TELEMETRY'] = '0'
        os.environ['CBS_MEMORIA_MODEL'] = str(state / 'artifacts/model.onnx')
        os.environ['CBS_MEMORIA_TOKENIZER'] = str(state / 'artifacts/tokenizer.json')
        os.environ.pop('OPENAI_API_KEY', None)
        with self.assertRaises(HTTPError) as unauth:
            urlopen(f'http://127.0.0.1:{port}/collections', timeout=5)
        self.assertEqual(unauth.exception.code, 401)

        connection = {'url': f'http://localhost:{port}/', 'hostname': 'localhost',
                      'address': '127.0.0.1', 'port': port, 'protocol': 'http:', 'servername': 'localhost'}
        client = QdrantClient(url=connection['url'], api_key=key,
                              transport=adapter.PinnedTransport(connection), trust_env=False,
                              follow_redirects=False, prefer_grpc=False, check_compatibility=False)
        collection = 'task3_' + secrets.token_hex(5)
        wrong = collection + '_wrong'
        try:
            client.create_collection(collection, vectors_config=models.VectorParams(size=384, distance=models.Distance.COSINE),
                                     metadata={'cbs_embedding_fingerprint': adapter.FINGERPRINT})
            client.create_collection(wrong, vectors_config=models.VectorParams(size=1024, distance=models.Distance.COSINE),
                                     metadata={'cbs_embedding_fingerprint': adapter.FINGERPRINT})
            base = {'collection': collection, 'connection': connection, 'projectId': 'project-A',
                    'externalId': 'source-claude-s1-0-25-policy1'}
            metadata = {'source': 'message-1', 'actor': 'owner', 'origin': 'user_direct',
                        'scope': 'project', 'evidence_at': '2026-09-30T12:00:00Z'}
            with self.assertRaisesRegex(ValueError, 'collection_fingerprint_mismatch'):
                adapter.execute({**base, 'collection': wrong, 'op': 'add', 'sessionId': 's1',
                                 'text': 'Review before release', 'metadata': metadata}, client, state)
            self.assertEqual(client.count(wrong).count, 0)
            added = adapter.execute({**base, 'op': 'add', 'sessionId': 's1',
                                     'text': 'Review before release', 'metadata': metadata}, client, state)
            self.assertEqual(added['kind'], 'pending')
            self.assertEqual(adapter.execute({**base, 'op': 'find'}, client, state)['items'][0]['status'], 'pending')
            active = adapter.execute({**base, 'op': 'activate', 'sdkId': added['sdkId']}, client, state)['item']
            self.assertEqual((active['sdkId'], active['qdrantId'], active['status']),
                             (added['sdkId'], added['sdkId'], 'active'))
            self.assertEqual(adapter.execute({**base, 'op': 'search', 'query': 'release review'}, client, state)['items'][0]['sdkId'],
                             added['sdkId'])
            self.assertEqual(adapter.execute({**base, 'projectId': 'project-B', 'op': 'search',
                                              'query': 'release review'}, client, state)['items'], [])
            late = adapter.execute({**base, 'op': 'add', 'sessionId': 's1',
                                    'text': 'Review before release', 'metadata': metadata}, client, state)
            rows = adapter.execute({**base, 'op': 'find'}, client, state)['items']
            self.assertEqual({r['status'] for r in rows}, {'active', 'pending'})
            self.assertEqual(sum(r['status'] == 'active' for r in rows), 1)
            self.assertNotEqual(late['sdkId'], added['sdkId'])
            revised = {**base, 'externalId': 'source-codex-s2-0-28-policy2'}
            correction = adapter.execute({**revised, 'op': 'add', 'sessionId': 's2',
                                          'text': 'Review and test before release',
                                          'metadata': {**metadata, 'supersedes_id': added['sdkId']}}, client, state)
            adapter.execute({**revised, 'op': 'activate', 'sdkId': correction['sdkId']}, client, state)
            self.assertEqual(adapter.execute({**base, 'op': 'read', 'sdkId': added['sdkId']}, client, state)['item']['status'],
                             'superseded')
            self.assertEqual(adapter.execute({**revised, 'op': 'read', 'sdkId': correction['sdkId']}, client, state)['item']['status'],
                             'active')
            personal = {**base, 'externalId': 'source-personal-s3-policy1'}
            private = adapter.execute({**personal, 'op': 'add', 'sessionId': 's3',
                                       'text': 'My private release note',
                                       'metadata': {**metadata, 'scope': 'personal', 'owner_id': 'owner-A'}}, client, state)
            adapter.execute({**personal, 'op': 'activate', 'sdkId': private['sdkId']}, client, state)
            self.assertNotIn(private['sdkId'], [row['sdkId'] for row in adapter.execute(
                {**personal, 'op': 'search', 'query': 'private release note'}, client, state)['items']])
            self.assertIn(private['sdkId'], [row['sdkId'] for row in adapter.execute(
                {**personal, 'op': 'search', 'query': 'private release note', 'ownerId': 'owner-A'},
                client, state)['items']])
            client.delete_payload(collection_name=collection, keys=['owner_id'], points=[private['sdkId']])
            self.assertNotIn(private['sdkId'], [row['sdkId'] for row in adapter.execute(
                {**personal, 'op': 'search', 'query': 'private release note'}, client, state)['items']])
            self.assertEqual(adapter.NoGenerateLLM.calls, 0)
            self.assertFalse((home / '.mem0').exists())
        finally:
            client.delete_collection(collection)
            client.delete_collection(wrong)
            client.close()


if __name__ == '__main__':
    unittest.main()
