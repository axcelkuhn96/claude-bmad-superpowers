"""Concurrent Qdrant fixtures with independent adapter state roots."""

import importlib.util
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
from threading import Event, Lock
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

from qdrant_client.models import UpdateMode

MODULE = Path(__file__).resolve().parents[1] / 'base/memoria/python/mem0_adapter.py'
spec = importlib.util.spec_from_file_location('mem0_adapter', MODULE)
adapter = importlib.util.module_from_spec(spec)
sys.modules['mem0_adapter'] = adapter
spec.loader.exec_module(adapter)


class SharedQdrant:
    def __init__(self):
        self.lock = Lock()
        self.points = {}
        self.writes = []
        self.status = 'completed'
        self.marker = None

    def info(self):
        return SimpleNamespace(version='1.19.1')

    def upsert(self, collection_name, points, wait, ordering, update_mode):
        assert wait and ordering == 'strong' and update_mode == UpdateMode.INSERT_ONLY
        with self.lock:
            self.writes.append(('insert', points[0].id))
            for point in points:
                self.points.setdefault(point.id, SimpleNamespace(
                    id=point.id, payload=point.payload.copy(), vector=point.vector.copy()))
        return SimpleNamespace(status=self.status)

    def retrieve(self, collection_name, ids, **kwargs):
        with self.lock:
            return [self.points[key] for key in ids if key in self.points]

    def scroll(self, **kwargs):
        conditions = kwargs['scroll_filter'].must
        with self.lock:
            points = [point for point in self.points.values() if all(
                point.payload.get(condition.key) == condition.match.value
                for condition in conditions)]
        return points[:kwargs['limit']], None

    def set_payload(self, collection_name, payload, points, wait, ordering):
        assert wait and ordering == 'strong'
        with self.lock:
            for point in self.points.values():
                if all((point.id in condition.has_id if hasattr(condition, 'has_id') else
                        point.payload.get(condition.is_null.key) is None if getattr(condition, 'is_null', None) else
                        point.payload.get(condition.key) == condition.match.value)
                       for condition in points.must):
                    point.payload.update(payload)
        return SimpleNamespace(status='completed')

    def delete(self, collection_name, points_selector, wait, ordering):
        assert wait and ordering == 'strong'
        with self.lock:
            for identifier, point in list(self.points.items()):
                if all((identifier in condition.has_id if hasattr(condition, 'has_id') else
                        point.payload.get(condition.key) == condition.match.value)
                       for condition in points_selector.filter.must):
                    del self.points[identifier]
        return SimpleNamespace(status='completed')


class Memory:
    embedding_model = SimpleNamespace(embed=lambda text, action: [0.1] * 384)

    def __init__(self, client=None):
        self.client = client

    def get(self, identifier):
        point = self.client.points.get(identifier)
        if point is None:
            return None
        payload = point.payload
        return {'id': identifier, 'memory': payload['data'], 'user_id': payload['user_id'],
                'run_id': payload['run_id'], 'metadata': adapter._point_metadata(payload)}

    def update(self, identifier, metadata):
        self.client.points[identifier].payload.update(metadata)


class MultiwriterTest(unittest.TestCase):
    def request(self, external, source, text='Shared note'):
        metadata = {'format_version': 5, 'source': 'mcp_request:' + source,
                    'actor': 'mcp_agent', 'origin': 'assistant_report',
                    'speaker_role': 'assistant', 'review_mode': 'explicit_mcp',
                    'source_text_sha256': hashlib.sha256(text.encode()).hexdigest(),
                    'auto_consent_hash': 'c' * 64, 'scope': 'project', 'type': 'decision',
                    'evidence_at': '2026-10-20T00:00:00Z'}
        metadata['dedup_key'] = adapter._dedup_key('p', metadata, text)
        raw = hashlib.sha256(json.dumps(['cbs-writer-v1', 'p', 'https://qdrant.example/', 'c'],
            ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:32]
        marker_id = str(uuid.UUID(raw))
        return {'op': 'add', 'collection': 'c', 'projectId': 'p',
                'externalId': external, 'sessionId': 's', 'text': text,
                'metadata': metadata, 'connection': {'url': 'https://qdrant.example/',
                    'controlPointId': marker_id}}

    def marker(self, client):
        request = self.request('unused', '0' * 64)
        identifier = request['connection']['controlPointId']
        client.points[identifier] = SimpleNamespace(id=identifier,
            payload={'cbs_control': 'writer_v2', 'projectId': 'p', 'collection': 'c',
                     'mode': 'database', 'protocol': 2}, vector=[0.0] * 384)

    def test_two_state_roots_same_dedup_have_one_pending_owner(self):
        client = SharedQdrant()
        self.marker(client)
        requests = [self.request('source-a', 'a' * 64),
                    self.request('source-b', 'b' * 64)]
        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=Memory()), \
             ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda pair: adapter.execute(pair[0], client, pair[1]),
                                    zip(requests, [Path('/tmp/one'), Path('/tmp/two')])))
        memories = [point for point in client.points.values() if point.payload.get('data')]
        self.assertEqual(len(memories), 1)
        self.assertEqual(sum(result['kind'] == 'pending' and 'sdkId' in result for result in results), 1)
        self.assertNotEqual(memories[0].payload['source_record_id'],
                            requests[1 if results[0].get('sdkId') else 0]['externalId'])

    def test_same_source_retry_preserves_payload_and_vector(self):
        client = SharedQdrant()
        self.marker(client)
        request = self.request('source-a', 'a' * 64)
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()):
            first = adapter.execute(request, client, Path('/tmp/one'))
            second = adapter.execute(request, client, Path('/tmp/two'))
            changed = adapter.execute({**request, 'text': 'Changed note',
                'metadata': {**request['metadata'], 'source_text_sha256': 'd' * 64,
                    'dedup_key': adapter._dedup_key('p', request['metadata'], 'Changed note')}},
                client, Path('/tmp/two'))
        self.assertEqual(first['sdkId'], second['sdkId'])
        self.assertEqual(changed['kind'], 'conflict')
        self.assertEqual(len([p for p in client.points.values() if p.payload.get('data')]), 1)

    def test_retry_refuses_payload_or_vector_drift_with_same_digest(self):
        client = SharedQdrant()
        self.marker(client)
        request = self.request('source-a', 'a' * 64)
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()):
            added = adapter.execute(request, client, Path('/tmp/one'))
            point = client.points[added['sdkId']]
            point.payload['actor'] = 'forged'
            with self.assertRaisesRegex(ValueError, 'remote_pending_unverified'):
                adapter.execute(request, client, Path('/tmp/two'))
            point.payload['actor'] = request['metadata']['actor']
            point.vector[0] = 0.2
            with self.assertRaisesRegex(ValueError, 'remote_pending_unverified'):
                adapter.execute(request, client, Path('/tmp/two'))

    def test_superseded_claim_can_be_taken_once_for_legitimate_readd(self):
        client = SharedQdrant()
        self.marker(client)
        first = self.request('source-a', 'a' * 64)
        second = self.request('source-b', 'b' * 64)
        third = self.request('source-c', 'c' * 64)
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()):
            added = adapter.execute(first, client, Path('/tmp/one'))
            client.points[added['sdkId']].payload['status'] = 'superseded'
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda pair: adapter.execute(pair[0], client, pair[1]),
                    zip([second, third], [Path('/tmp/two'), Path('/tmp/three')])))
        self.assertEqual(sum(result.get('sdkId') is not None for result in results), 1)
        self.assertEqual(len([p for p in client.points.values() if p.payload.get('data')]), 2)
        winner_id = next(result['sdkId'] for result in results if result.get('sdkId'))
        client.points[winner_id].payload['status'] = 'superseded'
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()):
            again = adapter.execute(self.request('source-d', 'd' * 64), client, Path('/tmp/four'))
        self.assertEqual(again['kind'], 'pending')
        self.assertIn(again['sdkId'], client.points)

    def test_confirmed_delete_retires_dedup_claim_and_allows_readd(self):
        client = SharedQdrant()
        self.marker(client)
        first = self.request('source-a', 'a' * 64)
        second = self.request('source-b', 'b' * 64)
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()):
            added = adapter.execute(first, client, Path('/tmp/one'))
            target = client.points[added['sdkId']]
            target.payload['status'] = 'active'
            row = adapter.validate_curated_payload(target, 'p', None, 'history')
            version = adapter._target_version(row)
            request = {'op': 'delete_curated', 'collection': 'c', 'projectId': 'p',
                       'connection': first['connection'], 'memoryId': added['sdkId'],
                       'expectedVersion': version, 'requestId': 'd' * 64}
            self.assertEqual(adapter.execute(request, client, Path('/tmp/one'))['kind'], 'deleted')
            self.assertEqual(adapter.execute(request, client, Path('/tmp/two'))['kind'], 'absent')
            same_source = adapter.execute(first, client, Path('/tmp/one'))
            self.assertEqual(same_source['kind'], 'pending')
            self.assertEqual(adapter.execute(second, client, Path('/tmp/two')),
                             {'kind': 'pending', 'reason': 'duplicate_pending'})
            client.points[same_source['sdkId']].payload['status'] = 'superseded'
            readded = adapter.execute(second, client, Path('/tmp/two'))
        self.assertEqual(readded['kind'], 'pending')
        self.assertIn(readded['sdkId'], client.points)

    def test_delete_crash_after_remote_absence_retires_on_same_operation_retry(self):
        client = SharedQdrant()
        self.marker(client)
        first = self.request('source-a', 'a' * 64)
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()):
            added = adapter.execute(first, client, Path('/tmp/one'))
            target = client.points[added['sdkId']]
            target.payload['status'] = 'active'
            version = adapter._target_version(adapter.validate_curated_payload(target, 'p', None, 'history'))
            request = {'op': 'delete_curated', 'collection': 'c', 'projectId': 'p',
                       'connection': first['connection'], 'memoryId': added['sdkId'],
                       'expectedVersion': version, 'requestId': 'd' * 64}
            with patch.object(adapter, '_retire_dedup', side_effect=RuntimeError('crash')):
                with self.assertRaisesRegex(RuntimeError, 'crash'):
                    adapter.execute(request, client, Path('/tmp/one'))
            self.assertNotIn(added['sdkId'], client.points)
            self.assertEqual(adapter.execute(request, client, Path('/tmp/one'))['kind'], 'absent')
            self.assertEqual(adapter.execute(self.request('source-b', 'b' * 64),
                                             client, Path('/tmp/two'))['kind'], 'pending')

    def test_delete_retry_takeover_barrier_never_activates_two_equivalent_points(self):
        client = SharedQdrant()
        self.marker(client)
        first = self.request('source-a', 'a' * 64)
        second = self.request('source-b', 'b' * 64)
        memory = Memory(client)
        deleted = Event()
        reacquired = Event()
        release_delete = Event()
        release_retry = Event()
        real_retire = adapter._retire_dedup
        real_acquire = adapter._acquire_dedup

        def pause_retire(*args):
            deleted.set()
            self.assertTrue(release_delete.wait(5))
            return real_retire(*args)

        def pause_reacquire(*args):
            result = real_acquire(*args)
            if args[3] == 'source-a':
                reacquired.set()
                self.assertTrue(release_retry.wait(5))
            return result

        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=memory):
            added = adapter.execute(first, client, Path('/tmp/one'))
            self.assertEqual(adapter.execute({**first, 'op': 'activate',
                'sdkId': added['sdkId']}, client, Path('/tmp/one'))['kind'], 'item')
            row = adapter.validate_curated_payload(client.points[added['sdkId']], 'p', None, 'history')
            version = adapter._target_version(row)
            deletion = {'op': 'delete_curated', 'collection': 'c', 'projectId': 'p',
                        'connection': first['connection'], 'memoryId': added['sdkId'],
                        'expectedVersion': version, 'requestId': 'd' * 64}
            with patch.object(adapter, '_retire_dedup', side_effect=pause_retire), \
                 patch.object(adapter, '_acquire_dedup', side_effect=pause_reacquire), \
                 ThreadPoolExecutor(max_workers=2) as pool:
                delete_future = pool.submit(adapter.execute, deletion, client, Path('/tmp/delete'))
                self.assertTrue(deleted.wait(5))
                retry_future = pool.submit(adapter.execute, first, client, Path('/tmp/retry'))
                self.assertTrue(reacquired.wait(5))
                release_delete.set()
                self.assertEqual(delete_future.result(timeout=5)['kind'], 'deleted')
                takeover = adapter.execute(second, client, Path('/tmp/takeover'))
                release_retry.set()
                retried = retry_future.result(timeout=5)
            self.assertEqual(retried['kind'], 'pending')
            self.assertIn('sdkId', retried)
            self.assertEqual(takeover, {'kind': 'pending', 'reason': 'duplicate_pending'})
            acknowledgements = []
            for request, result, root in ((second, takeover, '/tmp/takeover'),
                                          (first, retried, '/tmp/retry')):
                if result.get('sdkId'):
                    activated = adapter.execute({**request, 'op': 'activate',
                        'sdkId': result['sdkId']}, client, Path(root))
                    acknowledgements.append(activated)
            active = [point for point in client.points.values()
                      if point.payload.get('status') == 'active' and
                      point.payload.get('dedup_key') == first['metadata']['dedup_key']]
            self.assertLessEqual(len(active), 1)
            self.assertEqual(len([ack for ack in acknowledgements if ack['kind'] == 'item']),
                             len(active))

    def test_stale_dedup_epoch_cannot_activate_after_owner_takeover(self):
        client = SharedQdrant()
        self.marker(client)
        first = self.request('source-a', 'a' * 64)
        second = self.request('source-b', 'b' * 64)
        memory = Memory(client)
        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=memory):
            old = adapter.execute(first, client, Path('/tmp/one'))
            client.points[old['sdkId']].payload['status'] = 'superseded'
            new = adapter.execute(second, client, Path('/tmp/two'))
            stale = adapter.execute({**first, 'op': 'activate',
                'sdkId': old['sdkId']}, client, Path('/tmp/one'))
            current = adapter.execute({**second, 'op': 'activate',
                'sdkId': new['sdkId']}, client, Path('/tmp/two'))
        self.assertEqual(stale, {'kind': 'conflict', 'reason': 'dedup_claim_changed'})
        self.assertEqual(current['kind'], 'item')
        self.assertEqual(client.points[old['sdkId']].payload['status'], 'superseded')
        self.assertEqual(client.points[new['sdkId']].payload['status'], 'active')

    def test_legacy_claim_without_epoch_can_advance_after_point_absence(self):
        client = SharedQdrant()
        self.marker(client)
        request = self.request('source-a', 'a' * 64)
        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=Memory(client)):
            added = adapter.execute(request, client, Path('/tmp/one'))
            claim = client.points[adapter._point_id('dedup', 'p', request['metadata']['dedup_key'])]
            claim.payload.pop('epoch')
            claim.payload.pop('phase')
            client.points.pop(added['sdkId'])
            readded = adapter.execute(request, client, Path('/tmp/two'))
        self.assertEqual(readded['kind'], 'pending')
        self.assertIn('sdkId', readded)
        self.assertEqual(client.points[readded['sdkId']].payload['cbs_dedup_epoch'],
                         claim.payload['epoch'])

    def test_takeover_cas_rejects_claim_entering_activation(self):
        client = SharedQdrant()
        self.marker(client)
        first = self.request('source-a', 'a' * 64)
        second = self.request('source-b', 'b' * 64)
        with patch.object(adapter, 'verify_collection'), \
             patch.object(adapter, '_memory', return_value=Memory(client)):
            old = adapter.execute(first, client, Path('/tmp/one'))
            client.points[old['sdkId']].payload['status'] = 'superseded'
            claim = client.points[adapter._point_id('dedup', 'p', first['metadata']['dedup_key'])]
            real_set = client.set_payload
            def race_activation(*args, **kwargs):
                if kwargs['payload'].get('owner_external_id') == 'source-b':
                    claim.payload['phase'] = 'activating'
                return real_set(*args, **kwargs)
            with patch.object(client, 'set_payload', side_effect=race_activation):
                result = adapter.execute(second, client, Path('/tmp/two'))
        self.assertEqual(result, {'kind': 'pending', 'reason': 'duplicate_pending'})
        self.assertEqual(claim.payload['owner_external_id'], 'source-a')

    def test_unconfirmed_insert_never_acks(self):
        client = SharedQdrant()
        self.marker(client)
        client.status = 'acknowledged'
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()):
            with self.assertRaisesRegex(ValueError, 'remote_insert_unconfirmed'):
                adapter.execute(self.request('source-a', 'a' * 64), client, Path('/tmp/one'))

    def test_marker_and_server_version_are_required_before_write(self):
        client = SharedQdrant()
        request = self.request('source-a', 'a' * 64)
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()):
            with self.assertRaisesRegex(ValueError, 'writer_protocol_unavailable'):
                adapter.execute(request, client, Path('/tmp/one'))
            self.assertFalse(client.writes)
            self.marker(client)
            with patch.object(client, 'info', return_value=SimpleNamespace(version='1.15.4')):
                with self.assertRaisesRegex(ValueError, 'qdrant_insert_only_unavailable'):
                    adapter.execute(request, client, Path('/tmp/one'))
            self.assertFalse(client.writes)

    def test_read_only_key_and_control_payload_cannot_ack_or_recall(self):
        client = SharedQdrant()
        self.marker(client)
        request = self.request('source-a', 'a' * 64)
        with patch.object(adapter, 'verify_collection'), patch.object(adapter, '_memory', return_value=Memory()), \
             patch.object(client, 'upsert', side_effect=PermissionError('read only')):
            with self.assertRaises(PermissionError):
                adapter.execute(request, client, Path('/tmp/one'))
        forged = SimpleNamespace(id='00000000-0000-0000-0000-000000000001',
            payload={'cbs_control': 'target_v2', 'project_id': 'p', 'user_id': 'p',
                'data': 'Shared note', 'status': 'active', 'source_record_id': 'source-a',
                'scope': 'project', 'source': 'message', 'actor': 'owner',
                'origin': 'user_direct', 'speaker_role': 'user',
                'evidence_at': '2026-10-20T00:00:00Z'}, vector=[0.1] * 384)
        self.assertIsNone(adapter.validate_curated_payload(forged, 'p', None))
        with self.assertRaisesRegex(ValueError, 'control_point_denied'):
            adapter._row({'id': forged.id, 'memory': 'Shared note', 'user_id': 'p',
                'metadata': forged.payload}, SimpleNamespace(retrieve=lambda *args, **kwargs: [forged]),
                'c', Memory.embedding_model)

    def test_target_claim_single_winner_crash_retry_and_update_delete_race(self):
        target = '64eef286-9f7e-4326-b137-5658f0286c46'
        version = 'a' * 64
        for competing in ('update-b', 'delete'):
            client = SharedQdrant()
            def attempt(operation):
                return adapter._target_claim(client, 'c', 'p', target, version,
                    'd' * 64 if operation == 'delete' else operation + '-source',
                    'delete' if operation == 'delete' else 'update',
                    'source-a' if operation == 'delete' else None)
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(attempt, ['update', competing]))
            self.assertEqual(sum(results), 1)
            winner = 'update' if results[0] else competing
            loser = competing if results[0] else 'update'
            self.assertTrue(attempt(winner))  # Winner resumes after a crash.
            self.assertFalse(attempt(loser))


if __name__ == '__main__':
    unittest.main()
