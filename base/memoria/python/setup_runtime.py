"""Optional, project-local Mem0 runtime setup. No Mem0 import precedes isolation."""

import argparse
import hashlib
import importlib.metadata
import os
from pathlib import Path
import shutil
import subprocess
import sys
import venv


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
    "onnxruntime==1.30.0",
    "tokenizers==0.23.2",
    "numpy==2.5.3",
    "httpx==0.28.1",
    "httpcore==1.0.9",
)
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


def check_installed() -> None:
    for pin in PINS:
        package, version = pin.split("==")
        if importlib.metadata.version(package) != version:
            raise RuntimeError(f"version mismatch: {package}")
    from mem0.configs.base import MemoryConfig
    from mem0.memory.telemetry import MEM0_TELEMETRY

    if MEM0_TELEMETRY or not str(MemoryConfig().history_db_path).startswith(os.environ["MEM0_DIR"] + os.sep):
        raise RuntimeError("Mem0 state isolation failed")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--tokenizer", type=Path)
    parser.add_argument("--check", action="store_true")
    options = parser.parse_args()
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11 or newer required")
    state = options.state.resolve()
    isolation(state)
    if options.check:
        check_installed()
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
    subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", *PINS],
                   check=True, env=env)
    protect_windows_tree(runtime)
    artifacts = state / "artifacts"
    artifacts.mkdir(mode=0o700, exist_ok=True)
    shutil.copyfile(options.model, artifacts / "model.onnx")
    shutil.copyfile(options.tokenizer, artifacts / "tokenizer.json")
    protect_windows_tree(artifacts)
    if digest(artifacts / "model.onnx") != MODEL_SHA256 or digest(artifacts / "tokenizer.json") != TOKENIZER_SHA256:
        raise RuntimeError("artifact changed during copy")
    subprocess.run([str(python), __file__, "--state", str(state), "--check"], check=True, env=env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
