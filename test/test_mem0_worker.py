import importlib.util
import io
import json
import struct
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

import httpx
from qdrant_client.http.exceptions import ResponseHandlingException, UnexpectedResponse


def framed(request, secret=b'fixture-key'):
    body = json.dumps(request).encode('utf-8')
    return b'M0BW\x01' + struct.pack('>II', len(body), len(secret)) + body + secret


def responses(data):
    results = []
    source = io.BytesIO(data)
    while header := source.read(9):
        assert header[:5] == b'M0BR\x01'
        length = struct.unpack('>I', header[5:])[0]
        results.append(json.loads(source.read(length)))
    return results


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

    def test_sdk_network_errors_return_sanitized_response_and_preserve_warm_loop(self):
        secret = 'private-key-and-memory-text'
        failures = (
            httpx.ConnectError(secret),
            httpx.ReadTimeout(secret),
            UnexpectedResponse(401, secret, secret.encode(), httpx.Headers()),
            ResponseHandlingException(ValueError(secret)),
        )
        adapter = ModuleType('mem0_adapter')
        adapter.FINGERPRINT = 'fixture'
        adapter.E5Embedder = lambda: object()
        script = Path(__file__).resolve().parents[1] / 'base/memoria/python/worker.py'
        spec = importlib.util.spec_from_file_location('mem0_worker_fault_test', script)
        worker = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'mem0_adapter': adapter}):
            spec.loader.exec_module(worker)
            for failure in failures:
                with self.subTest(error=type(failure).__name__):
                    incoming = framed({'id': 1}, secret.encode()) + framed({'id': 2})
                    outgoing = io.BytesIO()
                    calls = []

                    def execute(request, key):
                        calls.append(request['id'])
                        if request['id'] == 1:
                            raise failure
                        return {'kind': 'items', 'items': [{'id': request['id']}]}

                    with patch.object(worker, 'execute_one', side_effect=execute), \
                         patch.object(sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(incoming))), \
                         patch.object(sys, 'stdout', SimpleNamespace(buffer=outgoing)):
                        self.assertEqual(worker.main(), 0)
                    parsed = responses(outgoing.getvalue())
                    self.assertEqual(parsed[0], {'kind': 'ready', 'fingerprint': 'fixture'})
                    self.assertEqual(parsed[1], {'kind': 'blocked', 'reason': 'worker_operation_failed'})
                    self.assertEqual(parsed[2], {'kind': 'items', 'items': [{'id': 2}]})
                    self.assertEqual(calls, [1, 2])
                    self.assertNotIn(secret, outgoing.getvalue().decode('utf-8'))


if __name__ == '__main__':
    unittest.main()
