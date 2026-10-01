import importlib.util
from pathlib import Path
import unittest

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


if __name__ == '__main__':
    unittest.main()
