"""Optional, project-local Mem0 runtime setup. No Mem0 import precedes isolation."""

import argparse
import ctypes
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import venv
import uuid


def protect_windows_tree(root: Path) -> None:
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                       ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                           ctypes.c_void_p, wintypes.DWORD,
                                           ctypes.POINTER(wintypes.DWORD)]
    advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p,
                                              ctypes.POINTER(ctypes.c_void_p)]
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.DWORD)]
    advapi.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
                                        ctypes.c_void_p]
    token = wintypes.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        size = wintypes.DWORD()
        advapi.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        data = ctypes.create_string_buffer(size.value)
        if not advapi.GetTokenInformation(token, 1, data, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        sid_pointer = ctypes.cast(data, ctypes.POINTER(ctypes.c_void_p))[0]
        text = ctypes.c_void_p()
        if not advapi.ConvertSidToStringSidW(sid_pointer, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            sddl = f"D:P(A;;FA;;;{ctypes.wstring_at(text)})(A;;FA;;;SY)(A;;FA;;;BA)"
        finally:
            kernel.LocalFree(text)
    finally:
        kernel.CloseHandle(token)
    descriptor = ctypes.c_void_p()
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl, 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        for directory, children, files in os.walk(root, followlinks=False):
            for name in [directory, *(str(Path(directory) / item) for item in children + files)]:
                if Path(name).is_symlink():
                    raise RuntimeError("runtime reparse point")
                if not advapi.SetFileSecurityW(str(name), 0x00000004, descriptor):
                    raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.LocalFree(descriptor)

PINS = (
    "mem0ai==2.2.1",
    "qdrant-client==1.19.1",
    "tokenizers==0.23.2",
    "numpy==2.5.3",
    "httpx==0.28.1",
    "httpcore==1.0.9",
)
ORT_PINS = {
    "cpu": "onnxruntime==1.30.0",
    "cuda": "onnxruntime-gpu[cuda,cudnn]==1.30.0",
    "directml": "onnxruntime-directml==1.24.4",
}
ORT_DISTRIBUTIONS = ("onnxruntime", "onnxruntime-gpu", "onnxruntime-directml")
MODEL_SHA256 = (
    "ca456c06b3a9505ddfd9131408916d"
    "d79290368331e7d76bb621f1cba6bc8665"
)
TOKENIZER_SHA256 = (
    "0b44a9d7b51c3c62626640cda0e2c"
    "2f70fdacdc25bbbd68038369d14ebdf4c39"
)


def digest(file: Path) -> str:
    value = hashlib.sha256()
    with file.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def isolation(state: Path) -> None:
    os.environ["MEM0_DIR"] = str(state / "mem0")
    os.environ["MEM0_TELEMETRY"] = "0"
    for name in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORGANIZATION", "OPENAI_PROJECT"):
        os.environ.pop(name, None)


def ort_pin(variant: str) -> str:
    return ORT_PINS[variant]


def windows_dx12_gpu_available() -> bool:
    try:
        probe = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                                'Get-CimInstance Win32_VideoController | ForEach-Object { $_.PNPDeviceID }'],
                               capture_output=True, text=True, timeout=3, check=False)
        if probe.returncode or not any('VEN_' + vendor in probe.stdout.upper()
                                        for vendor in ('1002', '10DE', '8086')):
            return False
        d3d12 = ctypes.WinDLL('d3d12.dll')
        create = d3d12.D3D12CreateDevice
        create.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p,
                           ctypes.POINTER(ctypes.c_void_p)]
        create.restype = ctypes.c_long
        interface = uuid.UUID('189819f1-1db6-4b57-be54-1821339b85f7')
        guid = ctypes.create_string_buffer(interface.bytes_le)
        device = ctypes.c_void_p()
        if create(None, 0xb000, guid, ctypes.byref(device)) < 0 or not device.value:
            return False
        vtable = ctypes.cast(device, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtable[2])(device)
        return True
    except Exception:
        return False


def select_variant_with_reason(device: str) -> tuple[str, str | None]:
    if device not in ("auto", *ORT_PINS):
        raise RuntimeError("invalid embedding device")
    if device == "cpu":
        return "cpu", None
    if device == "cuda" or (device == "auto" and sys.platform == "linux"):
        try:
            probe = subprocess.run(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"], capture_output=True,
                                   text=True, timeout=2, check=False)
            drivers = [int(version.split('.')[0]) for version in probe.stdout.splitlines()
                       if version.strip()]
            if probe.returncode == 0 and drivers and all(version >= 580 for version in drivers):
                return "cuda", None
        except (OSError, subprocess.TimeoutExpired, ValueError):
            pass
        return "cpu", "cuda_driver_unavailable"
    if device == "directml" or (device == "auto" and sys.platform == "win32"):
        if sys.platform != "win32" or platform.machine().lower() not in ("amd64", "x86_64") or \
                not (3, 11) <= sys.version_info[:2] <= (3, 14):
            return "cpu", "directml_platform_unsupported"
        try:
            build = int(platform.win32_ver()[1].split('.')[-1])
        except (ValueError, IndexError, OSError):
            build = 0
        if build < 18362:
            return "cpu", "directml_os_unsupported"
        if not windows_dx12_gpu_available():
            return "cpu", "directml_gpu_unavailable"
        return "directml", None
    return "cpu", "device_unsupported"


def select_variant(device: str) -> str:
    return select_variant_with_reason(device)[0]


def check_versions(variant: str) -> None:
    for pin in (*PINS, ort_pin(variant)):
        package, version = pin.split("==")
        package = package.split("[")[0]
        if importlib.metadata.version(package) != version:
            raise RuntimeError(f"version mismatch: {package}")
    for package in ORT_DISTRIBUTIONS:
        if package == ort_pin(variant).split("[")[0].split("==")[0]:
            continue
        try:
            importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            continue
        raise RuntimeError(f"conflicting ONNX Runtime distribution: {package}")


def check_installed(variant: str) -> None:
    check_versions(variant)
    from mem0.configs.base import MemoryConfig
    from mem0.memory.telemetry import MEM0_TELEMETRY

    if MEM0_TELEMETRY or not str(MemoryConfig().history_db_path).startswith(os.environ["MEM0_DIR"] + os.sep):
        raise RuntimeError("Mem0 state isolation failed")


def install_packages(python: Path, variant: str, env: dict) -> tuple[str, str | None]:
    command = [str(python), "-m", "pip"]
    subprocess.run([*command, "install", "--disable-pip-version-check", *PINS],
                   check=True, env=env)
    for candidate in (variant, "cpu") if variant != "cpu" else ("cpu",):
        subprocess.run([*command, "uninstall", "-y", *ORT_DISTRIBUTIONS],
                       check=True, env=env)
        try:
            subprocess.run([*command, "install", "--disable-pip-version-check", ort_pin(candidate)],
                           check=True, env=env)
            return candidate, None if candidate == variant else f"{variant}_install_failed"
        except subprocess.CalledProcessError:
            if candidate == "cpu":
                raise
    raise RuntimeError("runtime installation failed")


def write_receipt(state: Path, requested: str, selected: str, fallback_reason: str | None) -> None:
    target = state / "runtime-selection.json"
    temporary = state / f".runtime-selection-{os.getpid()}.tmp"
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump({"requested": requested, "selected": selected,
                       "fallback_reason": fallback_reason}, output)
            output.write("\n")
        os.replace(temporary, target)
        if os.name != "nt":
            os.chmod(target, 0o600)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--tokenizer", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--variant", choices=ORT_PINS)
    options = parser.parse_args()
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11 or newer required")
    state = options.state.resolve()
    isolation(state)
    if options.check:
        if options.variant:
            variant = options.variant
        else:
            with (state / "runtime-selection.json").open(encoding="utf-8") as source:
                variant = json.load(source)["selected"]
        check_installed(variant)
        return 0
    if options.model is None or options.tokenizer is None:
        parser.error("--model and --tokenizer are required for install")
    if digest(options.model) != MODEL_SHA256 or digest(options.tokenizer) != TOKENIZER_SHA256:
        raise RuntimeError("model/tokenizer hash mismatch")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    runtime = state / "runtime"
    venv.EnvBuilder(with_pip=True).create(runtime)
    protect_windows_tree(runtime)
    python = runtime / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    env = os.environ.copy()
    requested = os.environ.get("CBS_MEMORIA_EMBEDDING_DEVICE", "auto")
    variant, preflight_reason = select_variant_with_reason(requested)
    selected, reason = install_packages(python, variant, env)
    reason = preflight_reason or reason
    try:
        subprocess.run([str(python), __file__, "--state", str(state), "--check", "--variant", selected],
                       check=True, env=env)
    except subprocess.CalledProcessError:
        if selected == "cpu":
            raise
        selected, _ = install_packages(python, "cpu", env)
        reason = f"{variant}_check_failed"
        subprocess.run([str(python), __file__, "--state", str(state), "--check", "--variant", selected],
                       check=True, env=env)
    protect_windows_tree(runtime)
    artifacts = state / "artifacts"
    artifacts.mkdir(mode=0o700, exist_ok=True)
    shutil.copyfile(options.model, artifacts / "model.onnx")
    shutil.copyfile(options.tokenizer, artifacts / "tokenizer.json")
    protect_windows_tree(artifacts)
    if digest(artifacts / "model.onnx") != MODEL_SHA256 or digest(artifacts / "tokenizer.json") != TOKENIZER_SHA256:
        raise RuntimeError("artifact changed during copy")
    write_receipt(state, requested, selected, reason)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
