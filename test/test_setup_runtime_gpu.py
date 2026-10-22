import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'base/memoria/python/setup_runtime.py'
spec = importlib.util.spec_from_file_location('setup_runtime', SCRIPT)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class RuntimeGpuTests(unittest.TestCase):
    def test_linux_auto_uses_cuda_only_when_nvidia_probe_succeeds(self):
        with patch.object(setup.sys, 'platform', 'linux'):
            with patch.object(setup.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '615.37.01\n', '')) as run:
                self.assertEqual(setup.select_variant('auto'), 'cuda')
                run.assert_called_once()
                self.assertEqual(run.call_args.kwargs['timeout'], 2)
            with patch.object(setup.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '570.124.06\n', '')):
                self.assertEqual(setup.select_variant('auto'), 'cpu')
                self.assertEqual(setup.select_variant('cuda'), 'cpu')
            with patch.object(setup.subprocess, 'run', side_effect=FileNotFoundError):
                self.assertEqual(setup.select_variant('auto'), 'cpu')
                self.assertEqual(setup.select_variant('cuda'), 'cpu')
            with patch.object(setup.subprocess, 'run') as run:
                self.assertEqual(setup.select_variant('cpu'), 'cpu')
                run.assert_not_called()

    def test_windows_auto_only_selects_supported_dml_wheel(self):
        with patch.object(setup.sys, 'platform', 'win32'):
            with patch.object(setup.platform, 'machine', return_value='AMD64'):
                with patch.object(setup.platform, 'win32_ver', return_value=('10', '10.0.19045', '', '')):
                    with patch.object(setup, 'windows_dx12_gpu_available', return_value=True):
                        self.assertEqual(setup.select_variant('auto'), 'directml')
                    with patch.object(setup, 'windows_dx12_gpu_available', return_value=False):
                        self.assertEqual(setup.select_variant('auto'), 'cpu')
                        self.assertEqual(setup.select_variant_with_reason('auto'),
                                         ('cpu', 'directml_gpu_unavailable'))
                    with patch.object(setup.platform, 'win32_ver', return_value=('10', '10.0.17763', '', '')):
                        with patch.object(setup, 'windows_dx12_gpu_available') as probe:
                            self.assertEqual(setup.select_variant('auto'), 'cpu')
                            self.assertEqual(setup.select_variant_with_reason('auto'),
                                             ('cpu', 'directml_os_unsupported'))
                            probe.assert_not_called()
            with patch.object(setup.platform, 'machine', return_value='ARM64'):
                self.assertEqual(setup.select_variant('auto'), 'cpu')
                self.assertEqual(setup.select_variant('directml'), 'cpu')

    def test_windows_gpu_probe_rejects_software_adapter_before_d3d12(self):
        probe = subprocess.CompletedProcess([], 0, 'ROOT\\BasicDisplay\\0000\n', '')
        with patch.object(setup.subprocess, 'run', return_value=probe) as run:
            with patch.object(setup.ctypes, 'WinDLL', create=True) as dll:
                self.assertFalse(setup.windows_dx12_gpu_available())
                dll.assert_not_called()
                self.assertEqual(run.call_args.kwargs['timeout'], 3)

    def test_variant_has_exclusive_ort_pin(self):
        self.assertEqual(setup.ort_pin('cpu'), 'onnxruntime==1.30.0')
        self.assertEqual(setup.ort_pin('cuda'), 'onnxruntime-gpu[cuda,cudnn]==1.30.0')
        self.assertEqual(setup.ort_pin('directml'), 'onnxruntime-directml==1.24.4')
        self.assertFalse(any(pin.startswith('onnxruntime') for pin in setup.PINS))

    def test_installed_check_rejects_conflicting_ort_distributions(self):
        versions = {pin.split('==')[0]: pin.split('==')[1] for pin in setup.PINS}
        versions['onnxruntime-gpu'] = '1.30.0'
        def version(name):
            if name not in versions:
                raise setup.importlib.metadata.PackageNotFoundError(name)
            return versions[name]
        with patch.object(setup.importlib.metadata, 'version', side_effect=version):
            setup.check_versions('cuda')
        versions['onnxruntime'] = '1.30.0'
        with patch.object(setup.importlib.metadata, 'version', side_effect=version):
            with self.assertRaisesRegex(RuntimeError, 'conflicting'):
                setup.check_versions('cuda')

    def test_failed_cuda_install_cleans_conflicts_and_installs_cpu(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            if 'onnxruntime-gpu[cuda,cudnn]==1.30.0' in args:
                raise subprocess.CalledProcessError(1, args)
        with patch.object(setup.subprocess, 'run', side_effect=run):
            selected, reason = setup.install_packages(Path('/venv/bin/python'), 'cuda', {})
        self.assertEqual((selected, reason), ('cpu', 'cuda_install_failed'))
        self.assertEqual(sum('uninstall' in args for args in calls), 2)
        self.assertIn('onnxruntime==1.30.0', calls[-1])
        self.assertNotIn('onnxruntime-gpu[cuda,cudnn]==1.30.0', calls[-1])

    def test_receipt_records_real_cpu_fallback_privately(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            setup.write_receipt(state, 'cuda', 'cpu', 'cuda_install_failed')
            receipt = state / 'runtime-selection.json'
            self.assertEqual(json.loads(receipt.read_text()), {
                'requested': 'cuda', 'selected': 'cpu',
                'fallback_reason': 'cuda_install_failed',
            })
            if os.name != 'nt':
                self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
