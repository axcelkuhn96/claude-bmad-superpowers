# Task 3 CPU fix 1 — environment caps

Base: `30df74cab0ff4bfa7ceb2146175ad346b46cbd73` on `feat/cbs-memoria`.

The private Python child now receives `OMP_NUM_THREADS=2`, `OPENBLAS_NUM_THREADS=1`, and `MKL_NUM_THREADS=1` after the parent environment is copied, so inherited larger values cannot win. The direct `mem0_adapter.py` entry point also sets the same values before importing the Qdrant SDK or numerical libraries. This changes no parent environment, global settings, tunables, dependencies, credential path, JSON protocol, authorization, transport, or remote vector verification. Existing ONNX `2/1`, sequential execution, no spinning, and CPU provider remain intact.

## TDD evidence

- Node RED: `node --test --test-name-pattern='bridge caps numerical threads' test/memoria-store.test.js` exited 1, with actual child environment `['64','64','64']` against expected `['2','1','1']`. GREEN: same command exited 0, 1/1.
- Python direct-entry RED: `PYTHONPATH=test python3 -m unittest test_mem0_adapter.AdapterTest.test_direct_entry_caps_inherited_threads_before_sdk_import -v` exited 1, inheriting `('64','64','64')`. GREEN: focused Python command exited 0, 2/2, including the lightweight fake ONNX session test. The fake SDK import records the environment at import time; no model is loaded and output excludes the test secret.

## Verification

- `node --test test/memoria-store.test.js`: exit 0, 12/12.
- `PYTHONPATH=test /tmp/cbs-mem0-runtime-m002-validacao-20261001/state/runtime/bin/python -m unittest test_mem0_adapter -v`: exit 0, 7 passed, 1 skipped because pinned model/tokenizer paths were not supplied. The prior real model/vector check is recorded in `task-3-cpu-implementation-report.md`; it was not repeated for this environment-only fix.
- `git diff --check`: exit 0.
- `node /home/axcel/.claude/scripts/gate-seguranca.js`: exit 0, **approved with reservations / partial**. Gitleaks found 0 secrets; Semgrep is disabled by the user and npm audit could not run without the lockfile/network. The gate reported stack `node`.

No heavy benchmark, Docker crash matrix, full npm suite, native CLI, GPU, or Windows test was rerun. This change establishes thread caps, not a measured CPU reduction or ≤1 s recall. Model reuse/warm worker remains Task 6; p50/p95 and CPU/RSS measurements remain Task 7. Native Windows/PowerShell and GPU support are future scope.
