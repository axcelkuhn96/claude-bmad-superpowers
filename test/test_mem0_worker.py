import importlib.util
import io
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


class WorkerReadinessTest(unittest.TestCase):
    def test_qdrant_class_loaded_before_ready_and_client_remains_per_operation(self):
        events = []
        clients = []
        qdrant = ModuleType('qdrant_client')

        class Client:
            def __init__(self, **kwargs):
                events.append('client')
                self.kwargs = kwargs
                clients.append(self)

            def close(self):
                events.append('close')

        def load_class(name):
            if name != 'QdrantClient':
                raise AttributeError(name)
            events.append('import')
            return Client

        qdrant.__getattr__ = load_class
        adapter = ModuleType('mem0_adapter')
        adapter.FINGERPRINT = 'fixture'
        adapter.E5Embedder = lambda: events.append('e5')
        adapter.PinnedTransport = lambda connection: SimpleNamespace(close=lambda: None)
        adapter.execute = lambda request, client, state: {'kind': 'items', 'items': []}
        script = Path(__file__).resolve().parents[1] / 'base/memoria/python/worker.py'
        spec = importlib.util.spec_from_file_location('mem0_worker_under_test', script)
        worker = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'qdrant_client': qdrant, 'mem0_adapter': adapter}):
            spec.loader.exec_module(worker)
            with patch.object(worker, 'send', side_effect=lambda value: events.append(value['kind'])), \
                 patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO())):
                self.assertEqual(worker.main(), 0)
            self.assertIn('import', events)
            self.assertLess(events.index('import'), events.index('ready'))
            self.assertNotIn('client', events)
            request = {'op': 'search', 'state': '/tmp', 'connection': {'url': 'https://fixture.invalid/'}}
            for _ in range(2):
                self.assertEqual(worker.execute_one(request, b'fixture-key')['kind'], 'items')
        self.assertEqual(len(clients), 2)
        self.assertIsNot(clients[0], clients[1])
        self.assertEqual([client.kwargs['api_key'] for client in clients], ['fixture-key'] * 2)
        self.assertEqual(events.count('close'), 2)


if __name__ == '__main__':
    unittest.main()
