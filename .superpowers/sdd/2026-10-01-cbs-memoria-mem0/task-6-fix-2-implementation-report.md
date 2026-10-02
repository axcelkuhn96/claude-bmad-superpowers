# M0-06 fix round 2 — implementation evidence

Status: **ready for review of the two assigned Important findings** on `feat/cbs-memoria`, base `fd7f86d`. Product files changed: `base/memoria/native.mjs`, `base/memoria/broker.mjs`, `test/memoria-integration.test.js`. No E5, Qdrant, installed CLI, user profile, native Windows, N8N, publish, push, or full package suite was exercised. Only fixture sockets and worktrees were used.

## Root cause and correction

1. A failed last-owner Git exclusion release persisted `{releasing: oldRoot, owners: []}`. Acquisition by a new worktree appended its owner but left `releasing`; the old root's retry then removed the shared block and lease. Under the existing project lock, acquisition now retires `releasing`, preserves the newly acquired owner, and restores a CBS-owned block if the preceding release had already removed it. Retry of an old `releasing` state with owners completes without deleting those owners. A real Git worktree interleaving verifies the new checkout remains excluded and verified after the old root retries, then the new final release removes both CBS blocks and both lease files.
2. `readBrokerRequest` accepted fragmented frames but let a partial frame hold the socket, active count, and single encoder indefinitely. Each connection now has an absolute 1,000 ms reception deadline, checked against monotonic time before accepting even if timer dispatch is late. An incomplete client is destroyed; the broker's existing `close` listener decrements active count and rearms its five-minute idle timer. The fixture shortens the receiver to 80/50 ms and observes no request acceptance, socket close, active count zero, and stub idle close. The existing real two-write valid frame remains accepted.

The first body-drip test accidentally formed an invalid header and passed before the fix. I corrected it to send a complete header followed by body-byte drips, then observed the expected RED. A separate test holds only a partial header open.

## RED → GREEN

| Stage | Exact command | Result |
|---|---|---|
| RED lease | `node --test --test-name-pattern='native rollback retry preserves' test/memoria-integration.test.js` | exit 1; 0/1; `assert.ok(text.includes('/.codex/config.toml'))` failed after the first root's retry removed the new owner's block. |
| RED broker | `node --test --test-name-pattern='broker closes an incomplete' test/memoria-integration.test.js` | exit 1; 0/1; `Error: broker_not_idle` after 359 ms with a body-byte drip. |
| GREEN lease | same lease command | exit 0; 1/1. |
| GREEN broker | `node --test --test-name-pattern='broker closes an incomplete|broker accepts one request split' test/memoria-integration.test.js` | exit 0; 2/2; split frame 20 ms, incomplete frame and idle 104 ms. |

## Verification

| Command | Observed output |
|---|---|
| `node --test test/memoria-integration.test.js` (Node 24.16.0) | exit 0; 22 tests, 22 pass, 0 fail; 3,828 ms. |
| `npm exec --yes --package=node@18 -- node --test test/memoria-integration.test.js` (Node 18.20.8) | exit 0; 22 tests, 22 pass, 0 fail; 3,888 ms. |
| `git diff --check` | exit 0, no output. |
| `node /home/axcel/.claude/scripts/gate-seguranca.js` | exit 0; gitleaks 0; **APROVADO COM RESSALVAS**: Semgrep disabled by user, npm audit unavailable without lockfile. |

Node convention: ESM `.mjs`, `node:test`, no new dependency or production config flag. Integration pattern: existing `FrameReader` and per-project lease lock; no new external connector, key transport, retry, or HTTP call. Ponytail: reused the existing lock and server close/idle path; no added service or state file. Security: incomplete frames never reach `accept`, authorization, or the worker; parsed frame secrets are cleared on late rejection. Shared Git blocks stay present while a worktree owns the lease. No silent catch, credential, or cross-project path was added.

Remaining external gates are unchanged: real E5/Qdrant queue and total recall ≤1,000 ms, installed CLI/session correlation and native context delivery, capture p95 ≤250 ms, default/Mem0 route sentinels, holdout, and native Windows ownership/ACL/hardware proof. This scoped round makes no PASS claim for them. Full `npm test` was intentionally not run under the round's focused Node 18/24 instruction.
