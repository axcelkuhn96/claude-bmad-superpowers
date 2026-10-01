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

PINS = (
    "mem0ai==2.2.1",
    "qdrant-client==1.19.1",
    "onnxruntime==1.30.0",
    "tokenizers==0.23.2",
    "numpy==2.5.3",
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
    python = runtime / "bin" / "python"
    env = os.environ.copy()
    subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", *PINS],
                   check=True, env=env)
    artifacts = state / "artifacts"
    artifacts.mkdir(mode=0o700, exist_ok=True)
    shutil.copyfile(options.model, artifacts / "model.onnx")
    shutil.copyfile(options.tokenizer, artifacts / "tokenizer.json")
    if digest(artifacts / "model.onnx") != MODEL_SHA256 or digest(artifacts / "tokenizer.json") != TOKENIZER_SHA256:
        raise RuntimeError("artifact changed during copy")
    subprocess.run([str(python), __file__, "--state", str(state), "--check"], check=True, env=env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
