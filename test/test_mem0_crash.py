"""Repeatable SIGKILL matrix against a task-owned authenticated Qdrant container."""

import json
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.request import Request, urlopen

from qdrant_client import QdrantClient, models

IMAGE = 'qdrant/qdrant@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10'
REPO = Path(__file__).resolve().parents[1]
WORKER = REPO / 'test/memoria-crash-worker.mjs'


@unittest.skipUnless(os.environ.get('CBS_TASK3_CRASH_DOCKER') == '1', 'opt-in isolated Docker matrix')
class CrashMatrixTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(tempfile.mkdtemp(prefix='cbs-task3-crash-'))
        cls.root.chmod(0o700)
        cls.name = 'cbs-task3-crash-' + secrets.token_hex(5)
        cls.collection = 'crash_' + secrets.token_hex(5)
        key = secrets.token_urlsafe(32)
        key_file = cls.root / 'key'
        key_file.write_text(key)
        key_file.chmod(0o600)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            cls.port = sock.getsockname()[1]
        (cls.root / 'storage').mkdir()
        (cls.root / 'meta.json').write_text(json.dumps({'port': cls.port, 'collection': cls.collection}))
        cls.container = None
        try:
            command = ['docker', 'run', '-d', '--rm', '--name', cls.name,
                       '--label', 'cbs.task3.crash=owned', '-p', f'127.0.0.1:{cls.port}:6333',
                       '-v', f'{cls.root / "storage"}:/qdrant/storage',
                       '-e', f'QDRANT__SERVICE__API_KEY={key}', IMAGE]
            cls.container = subprocess.check_output(command, text=True).strip()
            for _ in range(60):
                try:
                    with urlopen(Request(f'http://127.0.0.1:{cls.port}/collections',
                                         headers={'api-key': key}), timeout=1) as response:
                        if response.status == 200:
                            break
                except Exception:
                    time.sleep(0.5)
            else:
                raise RuntimeError('owned_qdrant_not_ready')
            cls.client = QdrantClient(url=f'http://127.0.0.1:{cls.port}', api_key=key,
                                      check_compatibility=False)
            from test_mem0_remote import adapter
            cls.client.create_collection(cls.collection,
                vectors_config=models.VectorParams(size=384, distance=models.Distance.COSINE),
                metadata={'cbs_embedding_fingerprint': adapter.FINGERPRINT})
        except Exception:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'client'):
            cls.client.close()
        if cls.container:
            label = subprocess.check_output(['docker', 'inspect', '-f',
                '{{index .Config.Labels "cbs.task3.crash"}}', cls.container], text=True).strip()
            if label == 'owned':
                subprocess.run(['docker', 'rm', '-f', cls.container], check=True,
                               stdout=subprocess.DEVNULL)
        if hasattr(cls, 'root'):
            storage = cls.root / 'storage'
            if storage.exists():
                subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh',
                    '-v', f'{storage}:/fixture', IMAGE, '-c',
                    'rm -rf /fixture/aliases /fixture/collections'], check=True,
                    stdout=subprocess.DEVNULL)
            shutil.rmtree(cls.root)

    def _run_worker(self, external, stage):
        return subprocess.run(['node', str(WORKER), str(self.root), external, stage],
                              cwd=REPO, capture_output=True, text=True, timeout=180)

    def _remote(self, external):
        points, offset = self.client.scroll(self.collection,
            scroll_filter=models.Filter(must=[models.FieldCondition(
                key='source_record_id', match=models.MatchValue(value=external))]),
            limit=100, with_payload=True, with_vectors=True)
        self.assertIsNone(offset)
        return points

    def test_remote_sdk_regressions(self):
        env = {**os.environ, 'CBS_TASK3_REMOTE_DIR': str(self.root)}
        result = subprocess.run([str(Path('/tmp/cbs-mem0-runtime-m002-validacao-20261001/state/runtime/bin/python')),
            '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_mem0_remote.py', '-v'],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_sigkill_boundaries_and_replay(self):
        stages = ('before_enqueue', 'after_enqueue', 'before_remote_store',
                  'after_remote_add', 'after_active_before_ack', 'after_ack')
        for stage in stages:
            with self.subTest(stage=stage):
                external = 'crash-' + stage.replace('_', '-')
                first = self._run_worker(external, stage)
                self.assertEqual(first.returncode, -signal.SIGKILL, first.stderr)
                self.assertIn('KILL:' + stage, first.stdout)
                pre = self._remote(external)
                ledger_file = self.root / 'ledger-state/ledger' / \
                    (hashlib.sha256(external.encode()).hexdigest() + '.json')
                prior_ledger = json.loads(ledger_file.read_text()) if ledger_file.exists() else None
                ack = self.root / f'{external}.ack'
                if stage == 'before_enqueue':
                    self.assertIsNone(prior_ledger)
                elif stage == 'after_active_before_ack' or stage == 'after_ack':
                    self.assertEqual(prior_ledger['status'], 'canonical')
                    self.assertEqual(prior_ledger['canonicalId'], str(pre[0].id))
                else:
                    self.assertEqual(prior_ledger['status'], 'queued')
                    self.assertIsNone(prior_ledger['canonicalId'])
                if stage in ('before_enqueue', 'after_enqueue', 'before_remote_store'):
                    self.assertEqual(pre, [])
                if stage == 'after_remote_add':
                    self.assertEqual([p.payload['status'] for p in pre], ['pending'])
                if stage in ('after_active_before_ack', 'after_ack'):
                    self.assertEqual([p.payload['status'] for p in pre], ['active'])
                self.assertEqual(ack.exists(), stage == 'after_ack')
                prior_adds = (self.root / f'{external}.add').read_text().count('add') if \
                    (self.root / f'{external}.add').exists() else 0
                replay = self._run_worker(external, 'replay')
                self.assertEqual(replay.returncode, 0, replay.stderr)
                result = json.loads(replay.stdout.strip().splitlines()[-1])
                self.assertEqual(result['kind'], 'stored')
                final = self._remote(external)
                self.assertEqual(sum(p.payload['status'] == 'active' for p in final), 1)
                self.assertEqual(len(final), 1)
                self.assertEqual(result['sdkId'], str(final[0].id))
                self.assertEqual(json.loads(ack.read_text())['sdkId'], str(final[0].id))
                final_ledger = json.loads(ledger_file.read_text())
                self.assertEqual(final_ledger['status'], 'acked')
                self.assertEqual(final_ledger['canonicalId'], str(final[0].id))
                adds = (self.root / f'{external}.add').read_text().count('add')
                self.assertEqual(adds, 1)
                if stage in ('after_remote_add', 'after_active_before_ack', 'after_ack'):
                    self.assertEqual(adds, prior_adds, 'replay performed a second SDK add')


if __name__ == '__main__':
    unittest.main()
