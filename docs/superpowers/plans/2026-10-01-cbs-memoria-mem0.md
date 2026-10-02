# Memória CBS Mem0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user's “pode aplicar o plano” on 2026-10-01 authorizes execution; there is no second plan approval gate.

**Goal:** Offer Mem0 OSS as an explicit, isolated project choice in Claude Code and Codex, with extraction/embedding on the client and only private Qdrant on the server.

**Architecture:** Preserve claude-mem as the default and freeze a provider per session. For opt-in projects, native hooks capture durable transcript slices into a local outbox, a local CLI extracts reviewed candidates, and a local Python Mem0/E5 adapter stores and recalls them from project-scoped Qdrant. M0-01 is a hard native-exclusivity gate before product code or deployment.

**Tech Stack:** Existing Node ESM package (Node ≥18, no new dependency for default), optional isolated Python runtime with pinned Mem0 OSS 2.2.1 and multilingual-E5-small ONNX 384d, Qdrant private/authenticated.

**Spec:** `/home/axcel/cbs-lab/docs/prds/cbs-memoria.md`; canonical epic and seven stories in `/home/axcel/cbs-lab/docs/stories/cbs-memoria-mem0/`. Prior corrected benchmark is exploratory evidence, not acceptance.

**Native prerequisite, 2026-10-01:** independent retest PASS limited releases Task 2. Initial Claude shared `.claude/settings.json` failed in a subdirectory. Use owned/untracked `<main-Git-checkout>/.claude/settings.local.json` instead; it suppressed the user-active plugin in root/subdirectory/worktree/symlink/native subagent and simultaneous default/opt-in fixtures. Legitimate interactive trust was exercised. Codex local marketplace plugin exclusion and `/hooks` trust without bypass passed. Scope is eligible Git plus standard native launch settings; reject non-Git/unsupported ownership, inherited nested-Git identity, conflicting launch overrides and workspace-managed plugins. These proofs do not approve Mem0 installation, routing, replay, storage or quality; activation waits for remaining gates. Evidence: `/home/axcel/cbs-lab/docs/analises/2026-10-01-prova-hooks-mem0.md`; review: `.superpowers/sdd/2026-10-01-cbs-memoria-mem0/task-1-retest-review.md`.

## Global Constraints

- Product checkout: `/home/axcel/claude-bmad-superpowers`, branch `feat/cbs-memoria`, base `68c311d96f2e2336636979ae15fc694c188b1ced` from `release/0.13.1`; preserve this branch and use no new worktree.
- The user's approval covers this plan and M0-01 probes. No npm/GitHub publication, push, merge, version bump, global claude-mem change, or N8N change. Stop product code if M0-01 fails either CLI; write the evidence and decision. Installed CLIs at intake: Claude 2.1.287 and Codex 0.159.3; actual global claude-mem is off. Preserve that state and its hash. User authorized the `claude2` account/profile for probes; do not change global config. Task 5 may use it for a configured Sonnet alternative if the CLI route is proved; initial Sol choice remains.
- No Mem0 API/server, PostgreSQL, pgvector, dashboard, transcript upload, global personal memory, or cross-provider sync. Qdrant is the only remote service; client owns SDK, E5 and CLI extraction.
- The default project needs only Node ≥18 and retains current claude-mem behavior. Opt-in trust is local, outside the repository; an untrusted `.cbs/memoria.json` never chooses a secret or destination. Provider changes take effect only in a new session.
- Initial auto-publication is off. Active memories require source/actor/date/scope and review. Never reinterpret a tool or assistant report as a human rule; current human instruction outranks recalled text.
- Proposed budgets: capture/enqueue p95 ≤250 ms, recall total deadline 1,000 ms, outbox 256 MiB/project with alert at 80%, ≤4 automatic CLI calls/session, ≤5 candidates/checkpoint, rendered context ≤500 tokens. Measure; change only by explicit documented decision before opt-in release. Local E5 CPU must be bounded: default ONNX intra-op 2, inter-op 1 and sequential execution, no busy spinning, plus child-only OMP_NUM_THREADS=2/OPENBLAS_NUM_THREADS=1/MKL_NUM_THREADS=1 before numeric imports; this is a thread limit, not a measured CPU percentage guarantee. The adapter and extraction remain client-local; the server contains only Qdrant.
- Confirmed target environments: owner uses native Linux + NVIDIA; brother will use native Windows/PowerShell + AMD, without requiring WSL. Preserve Linux proof and prepare/test Windows portability explicitly; Linux native-hook/ownership proof does not certify Windows. CPU is the bounded default; GPU is optional with no mandatory CUDA/ROCm download. Windows DirectML uses a separately pinned compatible runtime and needs actual native hardware/vector-equivalence/resource validation. Reject Windows activation until native exclusion/trust/ACL/durable recovery checks are genuinely demonstrated; do not silently approve POSIX uid/mode assumptions there. Evidence and minimum changes: `/home/axcel/cbs-lab/docs/decisoes/2026-10-01-windows-amd-mem0.md`.
- Use named Codex roles from `models.yml`: `architect_sol` for difficult gate/rulings, `backend_terra` for implementation, `reviewer_sol` per task, `tester_luna` for operational tests, `final_reviewer_sol` for whole-branch review. No raw model names. One implementer at a time, one commit per task, no worker-created subagents.
- Never terminate or interrupt the user's existing Claude/Codex sessions, terminals or processes. No pkill, killall or process-name cleanup. Tests may signal only their directly spawned, recorded fixture children and remove only their owned containers; preserve all existing sessions.
- Preserve user changes. Read exact `/home/axcel/AGENTS.md` and the story before work. Browser automation, if needed, uses Playwright Python `/tmp/pwval` with visible Chrome on `DISPLAY=:1`; never `agent-browser`.

### Rulebooks CBS (read by path before acting; first existing path wins)

- Implementer: `~/.claude/skills/executor-bmad-superpowers/referencia/persona-dev.md` (fallback `/home/axcel/claude-bmad-superpowers/base/skills/executor-bmad-superpowers/referencia/persona-dev.md`).
- All: `~/.claude/cbs-overrides/personas/ponytail.md` → `~/.claude/personas/ponytail.md`; language `~/.claude/cbs-overrides/personas/dominios/<node|python>.md` → `~/.claude/personas/dominios/<node|python>.md`; area `integracao`/`database` where marked.
- Reviewers: `~/.claude/cbs-overrides/personas/review/seguranca.md` → `~/.claude/personas/review/seguranca.md` for backend; final also `cobertura-de-testes.md`. If absent, record path in report and continue.
- Summary: smallest change; preserve validation/security/tests; read persona→ponytail→language→area; RED→GREEN for business rules, measured E2E for operational work; backend runs `node ~/.claude/scripts/gate-seguranca.js` and records any partial gate; reports hold evidence; branch `feat/cbs-memoria`, no worktree.

## File and interface map (proposed; verify against M0-01/SDK before editing)

| Boundary | Files and contract |
|---|---|
| Native integration | Existing `src/hooks-settings.js`, `src/instalar.js`, `src/remover.js`, `src/caminhos.js`, `base/codex/hooks/codex-hooks.json`, `base/hooks/`. Probe before altering. The present installer writes Claude hooks globally; the Codex manifest exists but installation/trust behavior is unproved. |
| Selection | New `base/memoria/provider.mjs`, `project-id.mjs`, `trust.mjs`; `resolveProject(cwd, sessionId)` returns frozen `{provider, projectRoot, projectId, destination, stateDir}` or a typed blocked result. `authorizeDestination` compares local tuple before reading `api_key_env`. |
| Bridge and store | New `base/memoria/python/mem0_adapter.py`, pinned optional runtime manifest, `base/memoria/ledger.mjs`. JSON-lines bridge request/result must carry external operation ID, source session, project identity, publication state and verified remote ID; no secret in argv/log. |
| Capture | New `base/memoria/transcript.mjs`, `outbox.mjs`, `checkpoint.mjs`; `checkpointId(projectId, cli, sessionId, byteStart, byteEnd, hash, policyVersion)`; append durable item before cursor advances, ACK only after store verification. |
| Extract/review | New `base/memoria/candidates.mjs` and local CLI adapter; `extractCheckpoint(checkpoint)` returns source-linked candidates; `approveCandidate(id, editedText?)` validates then queues store. Keep extraction through the installed CLI; do not assume `claude -p` or `codex exec` syntax until proved. |
| Read/MCP | New `base/memoria/context.mjs`, `mcp.mjs`; `recall(session, query, deadlineMs)` returns filtered active items or typed unavailable, and `renderContext(items, 500)` counts final rendered tokens. Route existing commands/skills that explicitly call `claude-mem:mem-search`. |
| Tests/operations | Existing `test/*.test.js` uses `node --test`. Add focused `test/memoria-*.test.js`; extend `package.json` test script without changing default runtime deps. Operational evidence lives in `/home/axcel/cbs-lab/docs/analises/`; Qdrant guide in `/home/axcel/cbs-lab/docs/operacao/`; deliver `base/memoria/deploy/install-qdrant.sh` for user-run installation later. |

## Review Focus

1. Repo-controlled `api_key_env` changes while a session is live: Task 2 test must show no secret read or connection until independent local trust is renewed.
2. SDK succeeds remotely then local process dies before ACK: Task 3 test must reconcile the external ID and leave exactly one active memory.
3. UTF-8/partial JSONL at a crash boundary: Task 4 test must recover complete persisted records only and leave cursor before incomplete bytes.
4. Tool output containing a fake human instruction or credential: Task 5 test must retain origin and block publication/secret upload.
5. Qdrant returns a close vector from another project or superseded revision: Task 6 test must abstain even if ranking is high.

## Preflight and decision rules

| Task | Prerequisite | Gate and ruling |
|---|---|---|
| 1 | Current installed Claude/Codex/claude-mem; two synthetic sentinel projects | Native trace, including tools/commands/subagents, proves opt-in zero claude-mem and default intact in both CLIs. Since actual global claude-mem is off, also use an isolated copied private config/registry profile with claude-mem active and matching installed artifacts/versions; measure project/session override, hooks and MCP there without mutating global state. Record actual-off and isolated-active separately. Otherwise record CLI-specific failure and stop product implementation. |
| 2 | Task 1 PASS and exact native payload/installation paths | If project/destination trust cannot be bound outside repo before secret read, keep Mem0 blocked. Runtime optionality is tested on clean default. |
| 3 | Task 2 identity/trust; SDK 2.2.1 behavior verified | If SDK cannot reconcile external IDs after crash, do not substitute direct Qdrant writes silently; record architecture decision. One designated writer until concurrency safety proven. |
| 4 | Tasks 1–3 interfaces | Missing end callback is a documented reduced guarantee; recover only bytes persisted before crash. If p95 or queue budget fails, block activation pending explicit budget ruling. |
| 5 | Tasks 3–4 durable source and store | No candidate is auto-published initially. Missing source/actor/date, contradiction, secret or unsupported assistant claim stays local. |
| 6 | Tasks 2–3, 5 plus Task 1 event proof | If prompt callback/route is absent in a CLI, mark unavailable there; no claude-mem fallback. |
| 7 | Tasks 1–6 pass and prospective human reference frozen | Any critical authorship/time/precedence/isolation failure blocks release even if store works. Deliver the user-requested install script; no production host or deployment is needed now. No publication/push. |

## Task 1: M0-01 native hooks and exclusivity (domínio: node+integracao; tipo: operacional; review: seguranca)

**Files:** Read existing `src/hooks-settings.js`, `src/instalar.js`, `src/remover.js`, `base/codex/hooks/codex-hooks.json`, `base/commands/*.md`, `base/skills/*`. Create only removable probes under `/tmp/cbs-mem0-probes/`, optional `test/memoria-hooks.test.js`, and report `/home/axcel/cbs-lab/docs/analises/2026-10-01-prova-hooks-mem0.md`. No product code before PASS.

**Interfaces:** Produces a per-CLI event/payload/trust/transcript matrix, an observed project-only claude-mem exclusion mechanism, and exact hook/MCP installation paths for Tasks 2/4/6. Label observed, unavailable, and untested separately.

- [ ] Capture versions/manifests and hash current global claude-mem-off state without changing it. Create two disposable projects with distinct synthetic strings and, if isolatable, a copied private claude-mem-active profile using the installed artifacts/versions; record profile differences, paths and cleanup command in the report. Never toggle global claude-mem.
- [ ] Make the probes record JSON lines `{cli,version,project,event,cwd,session,transcript,hookOrigin,mcpTool,contextEffect,writeDestination}`, with secrets and private transcript bodies omitted. A missing line is “not fired”, a line with no effect is “fired/early exit”, a line with effect is “fired/acted”.
- [ ] In real Claude Code and Codex sessions, exercise root, subdirectory, mapped worktree, parallel default/opt-in, prompt context, Stop, PreCompact, SessionEnd, MCP matcher/direct call, CBS command/skill/subagent, normal exit, interruption/terminal close and Qdrant unavailable. Compare the unchanged actual-off profile with the isolated-active profile; verify stored byte offsets after restart rather than assuming a final callback.
- [ ] Record the decisive assertion as a matrix, not a text answer: for every opt-in run under isolated-active profile, `claudeMemCaptures === 0 && claudeMemRecalls === 0 && claudeMemTools === 0`; simultaneously default sentinel must show the profile's active behavior. Actual-off profile must retain its off behavior. If no project-only exclusion exists with matching installed versions/artifacts, Task 1 FAIL and all later product tasks stay blocked.
- [ ] If a small repeatable harness is needed, write a `node:test` fixture with a failing positive control and passing zero-effect condition. Run `node --test test/memoria-hooks.test.js` and save versions, commands, sanitized traces and cleanup in the report; commit only product-repo harness if useful.

## Task 2: M0-02 selection, trust, identity and optional runtime (domínio: node+integracao; tipo: regra-de-negocio; review: seguranca)

**Files:** Create `base/memoria/provider.mjs`, `project-id.mjs`, `trust.mjs`, optional runtime manifest/setup script under `base/memoria/python/`, `test/memoria-provider.test.js`; modify `src/instalar.js`, `src/caminhos.js`, `src/hooks-settings.js` only as proved by Task 1.

**Interfaces:** `resolveProject(cwd: string, sessionId: string): Promise<Resolution>` returns frozen `{provider,projectRoot,projectId,destination:{url,collection,apiKeyEnv},stateDir}` or `{provider:'blocked',reason}`. `authorizeDestination(resolution: Resolution, localTrust: TrustTuple, readSecret: (envName:string)=>string|undefined): {kind:'authorized',key:string}|{kind:'blocked',reason:string}` compares canonical root + URL + collection + env-name **before** calling `readSecret`. Task 3 consumes only authorized destination; Tasks 4/6 consume frozen session provider.

Native findings refine the implementation: only native SessionStart initializes the persistent Mem0 session (`initializeSession`); resolve of an unknown Mem0 session returns `fresh_session`, so default needs no optional memory state and activation cannot switch a live default session on its next prompt. Recheck current config against the frozen tuple before secret/network. The versioned local trust record also binds `projectId`; changing it or lacking it requires renewed trust. Snapshot/restore native local plugin keys including prior absence; never enable a previously disabled user key on rollback. Node default installation and real user projects remain unchanged during fixture validation.

Review ruling: a mapped worktree requires its own explicit, semantically equivalent Mem0 selection before sharing the main identity. Main Mem0 plus absent worktree selection is typed blocked, because the native Claude main-checkout override also excludes claude-mem there; do not claim an independent default fallback. Equivalent formatting is allowed, differing identity/destination blocks. Git discovery must ignore inherited override variables and verify canonical cwd containment. Protected Qdrant requires an unauthenticated rejection probe; every future connection must revalidate private DNS and consume the checked pinned endpoint, not rely on initial activation.

- [ ] Write failing tests for: no config/default without Python; same explicit `project_id` at root/subdir/worktree and on second machine; nested independent ID; malformed config; provider change mid-session blocked; changed URL, collection or env-name yields `blocked: trust_changed` with a spy asserting zero env reads/connections. Example key assertion: `assert.equal(secretReads, 0)` after changing only `qdrant.collection`.
- [ ] Run `node --test test/memoria-provider.test.js` to observe RED; implement minimal resolution with canonical project root and explicit worktree mapping, schema validation and local trust record outside repo; rerun GREEN. Do not infer identity from basename or silently inherit nested project config.
- [ ] Add explicit activation/validation command only after native trust route is known. It rejects missing key, public/unprotected URL, absent or dimension/fingerprint-incompatible collection before session use; creating collection/key is a separate explicit setup action.
- [ ] Provision pinned optional Python/SDK/E5 in project CBS state; set SDK history path and disable telemetry before construction. Test by snapshotting `~/.mem0` and OpenAI env access before/after SDK init in opt-in and default paths; default must not create runtime or state. Run Node 18 tests and `npm test`.
- [ ] Document pin (SDK, ONNX model+tokenizer checksums, 384d, normalization, E5 `query:`/`passage:` prefixes) and trust record format without secret. Commit Task 2 when the reviewer accepts both default regression and trust tests.

Concrete RED test for `test/memoria-provider.test.js` (the module is proposed here, not asserted to exist today):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeDestination } from '../base/memoria/trust.mjs';

test('changed collection blocks before reading the credential', () => {
  const destination = { url: 'https://qdrant.internal', collection: 'cbs-p-new', apiKeyEnv: 'CBS_MEMORIA_QDRANT_KEY' };
  const resolution = { provider: 'mem0', projectRoot: '/projects/p', projectId: 'p', destination, stateDir: '/tmp/p-state' };
  const trusted = { projectRoot: '/projects/p', url: destination.url, collection: 'cbs-p-old', apiKeyEnv: destination.apiKeyEnv };
  let reads = 0;
  const result = authorizeDestination(resolution, trusted, () => { reads++; return 'synthetic-secret'; });
  assert.deepEqual(result, { kind: 'blocked', reason: 'trust_changed' });
  assert.equal(reads, 0);
});
```

## Task 3: M0-03 local Mem0, remote Qdrant and consistency (domínio: python+database; tipo: regra-de-negocio; review: seguranca)

**Files:** Create `base/memoria/python/mem0_adapter.py`, `base/memoria/ledger.mjs`, `test/memoria-store.test.js` plus Python focused tests if useful. Reuse Task 2 runtime/config.

**Interfaces:** JSON-lines bridge request `{op:'store'|'search', externalId,projectId,sessionId,text,metadata,queryVector?}`, result `{kind:'stored',externalId,sdkId,qdrantId,verified:true}|{kind:'pending'|'conflict'|'items',...}`; each line is one JSON object, no secret field. Node facade `reconcileStore(operation: {externalId,projectId,...}, deps: {findRemote,addViaSdk,ackLocal /* must return an explicit acked receipt bound to the exact externalId */}): Promise<{kind:'stored',externalId,sdkId,qdrantId,verified:true}|{kind:'pending',reason}>`; session-bound `searchProject({cwd,sessionId,query}) → items` (optional precomputed vector only if implemented). Project identity comes from current authorized session, never caller credentials/destination selection. Task 4 owns transport cursor; Task 5 calls only approved-store entry. Exact **SDK internals** are pinned by observed 2.2.1 source in this task; the facade contract here is independent of them.

Protocol preparation (`/home/axcel/cbs-lab/docs/analises/2026-10-01-consistencia-sdk-mem0.md`) observed SDK support for add(infer=False, pending metadata) → durable local canonical UUID → SDK update(active) → remote verification → ACK. Use that staged publication or prove an equally safe SDK protocol: a late uncertain add may create only inactive pending rows, and replay must not elect another active UUID after canonical identity was persisted. Source-filter pagination saturation must block rather than assume completeness. Restrict writing to one designated serialized client; transfer requires quiescence and canonical ledger handoff, not an invented Qdrant CAS/lease. Probe evidence is not authenticated remote acceptance; run the actual fault matrix in this task.

Task 2 now provides async `authorizeCurrentDestination`, which revalidates config/trust after private DNS lookup and returns `{kind:'authorized',key,connection}`. Fresh authorization is required for every bounded bridge operation; all sockets/requests use that operation's numeric private pin, preserve Host/SNI/TLS checks, and the client closes afterward. The key stays outside JSON/argv/logs. Follow `/home/axcel/cbs-lab/docs/analises/2026-10-01-transporte-privado-mem0.md`: inject a Qdrant client into SDK config, disable proxies, redirects, gRPC and `check_compatibility` (its version thread bypasses the pin). Freeze the tested HTTPX/httpcore behavior; test IPv6 or block it. No persistent client/pin across operations and no claim of a fresh DNS lookup per TCP socket.

- [ ] First inspect actual pinned SDK `add(infer=False)`, provider construction, Qdrant ID/payload, history path and query filter. Freeze a fixture with no OpenAI key and a provider spy that raises on any LLM generation.
- [ ] Write RED tests that store via SDK with `user_id=project_id`, `run_id=session_id`, then search by project without `run_id`; verify another session/CLI sees it, another project does not, and zero secondary LLM calls. Confirm E5 384d and exact fingerprint before writing.
- [ ] Write RED crash matrix: before local enqueue, after local enqueue, before remote store, after remote store/before ACK, after ACK, and replay; assert one active external ID and ACK only after a remote read verifies payload. Use source+policy-derived external IDs, never text similarity or clock. Keep failure codes/attempts; timeout is pending, not empty success.
- [ ] Implement local ledger, SDK/Qdrant ID reconciliation and immutable correction with `supersedes_id`, validity and conservative reads during partial update. Test a later human correction suppresses the old active version, while concurrent corrections become conflict. Enforce one designated writer across machines unless a real concurrency proof passes; second reader/capturer holds outbox until explicit transfer.
- [ ] Exercise authenticated private remote Qdrant A→B and unauthorized collection access with the actual credential scope; note an admin-wide key limits pilot to one owner/private network. Test incompatible dimension/fingerprint and no `~/.mem0/history.db` or telemetry. Run focused tests, `npm test`, security gate and commit.

Concrete RED test for `test/memoria-store.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStore } from '../base/memoria/ledger.mjs';

test('remote write before local ACK is reconciled without another SDK add', async () => {
  const operation = { externalId: 'src-claude-s1-0-84-v1', projectId: 'p' };
  const remote = { externalId: operation.externalId, projectId: 'p', sdkId: 'sdk-7', qdrantId: 'q-7', status: 'active' };
  let adds = 0;
  const acks = [];
  const result = await reconcileStore(operation, {
    findRemote: async (externalId) => externalId === remote.externalId ? remote : null,
    addViaSdk: async () => { adds++; throw new Error('duplicate write'); },
    ackLocal: async (externalId, proof) => { acks.push({ externalId, proof }); },
  });
  assert.deepEqual(result, { kind: 'stored', externalId: operation.externalId, sdkId: 'sdk-7', qdrantId: 'q-7', verified: true });
  assert.equal(adds, 0);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].proof.qdrantId, 'q-7');
});
```

### Task 3 supplementary CPU correction

The user observed high local CPU during actual tests. Read-only diagnosis confirmed a new Python/ONNX model load per operation and no explicit ONNX thread cap; it did not measure peak RSS or attribute CPU percentages. Before continuing product implementation, apply a small scoped E5 thread-limit correction and verify a real local normalized embedding with the pinned runtime. Preserve `_row` expected-vector checks and current per-operation authorization/client isolation. Do not repeat the heavy SIGKILL matrix for a thread-options-only change. Report this separately and obtain a fresh scoped review.

## Task 4: M0-04 transcript capture, outbox and recovery (domínio: node+integracao; tipo: regra-de-negocio; review: seguranca)

**Files:** Create `base/memoria/transcript.mjs`, `outbox.mjs`, `checkpoint.mjs`, `test/memoria-recovery.test.js`; touch existing hook manifests/scripts only at M0-01 verified points.

**Interfaces:** `readCompleteJsonl(buffer: Buffer, start=0): {records:Array<{value:object,start:number,end:number}>,lastCompleteByte:number}` is the format-neutral durable-byte reader; `parsePersistedSlice({cli,transcriptPath,start,end}) → {messages,lastCompleteByte}` maps proven native payloads; `enqueueCheckpoint(slice, identity) → operationId`; `ackVerified(operationId, remoteProof)` records a verified fact receipt; local checkpoint completion is distinct from remote ACK. A durable manifest binds zero to five stable child candidate IDs to the source checkpoint before any remote call. Each published child requires its own exact verified remote receipt; rejected/duplicate/no-publication outcomes have durable local audit dispositions, never a fake remote saved/acked claim. The processed source cursor advances only across completely resolved checkpoint manifests. Exact Claude/Codex message mapping waits on Task 1 native traces, not invented fixtures. Include CRLF and split UTF-8 offsets; design durable file primitives by platform, leaving Windows activation blocked until genuine NTFS/native proof. Capture cannot launch Python/model/DNS/key/network or a heavyweight ACL probe on each event. Extraction worker in Task 5 consumes queued records.

- [ ] Freeze actual Claude/Codex JSONL fixtures from sanitized M0-01 probes. Write RED assertions for human/assistant/tool roles, actor, timestamps, message IDs, byte offsets, UTF-8 split, partial last JSONL and two sessions with distinct IDs. A tool line saying “user decided X” must remain tool origin.
- [ ] Implement append/fsync/atomic-rename as needed so an outbox item is durable before cursor advancement. Write fault-injection tests at every file mutation; after restart, replay persisted complete bytes exactly once by operation ID. A missing SessionEnd only reduces recoverability to durable bytes.
- [ ] Bind SessionStart/Prompt/Stop/PreCompact/SessionEnd only where M0-01 proved them; capture hook enqueues locally and returns without model/network. Test 20 tool events in one turn produce no extraction calls, compact/restart preserve offsets, and unavailable Qdrant leaves queue pending.
- [ ] Fill a synthetic outbox to 80% of 256 MiB and then 256 MiB: alert, no ACK/cursor advance/full-data loss; release space and replay remaining persisted transcript. Measure capture/enqueue p95 ≤250 ms on both CLIs at acceptance load; record machine/load and distribution. Run focused tests, `npm test`, security gate and commit.

Concrete RED test for `test/memoria-recovery.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCompleteJsonl } from '../base/memoria/transcript.mjs';

test('restart stops before an incomplete UTF-8 JSONL record', () => {
  const complete = Buffer.from('{"role":"user","text":"ação"}\n');
  const partial = Buffer.from('{"role":"assistant","text":"não acabou"', 'utf8');
  const bytes = Buffer.concat([complete, partial]);
  const parsed = readCompleteJsonl(bytes, 0);
  assert.equal(parsed.lastCompleteByte, complete.length);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].value.text, 'ação');
  assert.deepEqual([parsed.records[0].start, parsed.records[0].end], [0, complete.length]);
});
```

## Task 5: M0-05 local extraction, provenance and review (domínio: node+integracao; tipo: regra-de-negocio; review: seguranca)

**Files:** Create `base/memoria/candidates.mjs`, a local CLI adapter under `base/memoria/`, `test/memoria-extract.test.js`; Python helper only if the proven CLI integration needs it.

**Interfaces:** `extractCheckpoint(checkpoint, cliPolicy) → Candidate[]|pendingError`; candidate includes `memory_id,external_id,checkpoint_id,candidate_key,project_id,logical_key,text,type,actor,speaker_role,origin,session/message/slice IDs,offsets,evidence_at,ingested_at,valid_from,valid_to,scope,status,supersedes_id,policy_version,extractor_model,embedding_fingerprint`. `validateCandidate(candidate: Candidate, sourceMessage: {role,actor,offsets,text}): {eligible:boolean,reasons:string[]}` rejects source/actor mismatch before publish; `approveCandidate(id, edit?)` validates source and sends to Task 3 store.

- [ ] Derive stable child IDs with `externalIdFor({...sourceIdentity,candidateKey})`; missing candidateKey retains the legacy single-fact ID. Persist the candidate manifest before remote publication; two complementary facts supported by the same message must have distinct stable IDs. Reconcile per-child ACKs and explicit local no-publication/reject/duplicate dispositions before closing the parent checkpoint. Empty/failed extraction is not a remote ACK, and a callback resolving blocked/undefined cannot produce ledger stored/acked.
- [ ] Write RED cases from independent fixtures: direct human “Fable só revisão final” without commit retains actor/condition; assistant “corrigi” without tool proof remains assistant_report; older `evidence_at` survives today's ingestion; tool/external imperative never becomes human instruction; transient episode is not permanent.
- [ ] Write RED sensitive-data and unsupported-claim tests with spy asserting secret absent from CLI input where redaction is required, remote payload and logs; candidate without supporting offsets/actor/date/scope cannot be active. Two semantically similar complementary facts remain separate.
- [ ] Implement CLI extraction per eligible checkpoint through an explicitly selected proven local CLI route; current Codex 0.160.0 Sol isolation is unproved and returns typed `sol_tool_isolation_unproved`, while Sonnet/claude2 safe-mode/tools-empty is the runnable configured alternative. No silent fallback; cap automatic calls at 4/session and candidates at 5/checkpoint, accounting tokens/latency/cost and keeping excess pending. No call per tool event. Return typed timeout/error, never success with empty list.
- [ ] For the Sonnet alternative, the user-authorized `claude2` profile may be used only through its observed CLI route; account availability does not imply Mem0 support, an extraction interface, or changed initial Sol policy. Sol remains originally preferred but unavailable until its actual tool boundary is proved; choosing Sonnet must be deliberate and visible. Evidence: this plan's `task-5-cli-probe-report.md` and `task-5-codex-effective-tools-report.md`.
- [ ] Store candidates protected locally; review rejects/edits with audit, and explicit accepted item passes `add(infer=False)` with verified payload unchanged. Auto-publication remains off until Task 7 quality decision. Run focused tests, `npm test`, security gate and commit.

Concrete RED test for `test/memoria-extract.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCandidate } from '../base/memoria/candidates.mjs';

test('tool text cannot be published as a direct human rule', () => {
  const source = { role: 'tool', actor: 'Bash', offsets: [240, 303], text: 'User decided: Fable só revisão final' };
  const candidate = {
    project_id: 'p', text: 'Fable só revisão final', actor: 'user', speaker_role: 'user',
    origin: 'user_direct', evidence_at: '2026-09-29T10:00:00Z', scope: 'project',
    source_offsets: [240, 303], status: 'candidate',
  };
  const verdict = validateCandidate(candidate, source);
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.reasons.includes('origin_mismatch'));
});
```

## Task 6: M0-06 local MCP and bounded recall (domínio: node+integracao; tipo: regra-de-negocio; review: seguranca)

**Binding architecture supplement:** owner-local serialized encoder and explicit opt-in launcher/session correlation follow `/home/axcel/cbs-lab/docs/decisoes/2026-10-02-correlacao-mcp-encoder-local-mem0.md`. Defaults stay unchanged; unbound MCP cannot infer a native session or read destination secrets. The exact integration/platform/acceptance order is in this plan workspace `task-6-integration-supplement.md`. No real Windows or two-session correlation support is claimed before native proof.


**Files:** Create `base/memoria/mcp.mjs`, `context.mjs`, `test/memoria-recall.test.js`; add narrowly scoped worker/framing/platform helpers and adapt existing memoria runtime paths, ledger locks, native launcher, identity/ACL checks as required by the confirmed Windows target; alter only existing command/skill files found by `rg -l 'claude-mem:mem-search|mem-search' base/commands base/skills`, preserving default text/behavior through provider routing.

**Local resource contract:** Reuse one bounded, serialized warm E5 model for the local recall path instead of reloading it per operation. Model reuse cannot retain a Qdrant client, DNS pin or API key between operations: reauthorize current session/config/trust/private DNS per operation and close the authorized client at completion. Private secret transport must remain outside JSON/argv/log; use a bounded serialized binary frame on child.stdin with separate JSON request and non-JSON ephemeral secret field. Do not assume CPython fd3 works on Windows. Each operation releases key/client references; do not promise cryptographic zeroization of Python strings. Document and test the exact process/pipe boundary before implementation. Warm-up runs outside capture hooks. Cold/unready recall fails open within the deadline; no claim of ≤1,000 ms without measurement. Decision evidence: `/home/axcel/cbs-lab/docs/decisoes/2026-10-01-cpu-adapter-mem0.md`.

**Interfaces:** `recall(session,query,1000) → {kind:'items',items}|{kind:'unavailable',reason}|{kind:'abstain'}`; `selectRecall(results: Memory[], {projectId:string,now:string}): Memory[]` filters identity/state/vigency before ranking; `renderContext(items,500) → string`. MCP methods search/source/propose/approve/correct/status derive identity from session; caller cannot supply another `project_id`.

- [ ] Write RED tests for same-project cross-session retrieval and hard filtering of candidate, conflict, rejected, superseded, expired and foreign-project items before ranking. A high-scoring foreign item must never render; a negative query must abstain.
- [ ] Write RED deadline test with slow embedder and Qdrant: total wall time ≤1,000 ms including local vectorization, then typed unavailable and no injected text. Warm E5 outside prompt. Assert rendered context ≤500 tokens with source/date/actor and current human instruction precedence; same `(ID,contentHash)` injects once per window, allowed after compaction.
- [ ] Implement MCP methods with session-bound identity, no secret in args/logs; source text from local transcript only on its machine, otherwise return remote metadata with clear limitation. Test explicit correction removes prior version from recall.
- [ ] Route prompts, commands, skills and subagents per frozen provider using observed native paths. In default sentinel, claude-mem call remains; in Mem0 sentinel, claude-mem calls stay zero even with Qdrant down. Run both CLI E2E, focused tests, `npm test`, security gate and commit.

Concrete RED test for `test/memoria-recall.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRecall } from '../base/memoria/context.mjs';

test('high vector score never bypasses project and revision filters', () => {
  const base = { valid_from: '2026-09-01T00:00:00Z', valid_to: null, text: 'Synthetic fact' };
  const hits = [
    { ...base, memory_id: 'foreign', project_id: 'other', status: 'active', score: 0.99 },
    { ...base, memory_id: 'old', project_id: 'p', status: 'superseded', score: 0.98 },
    { ...base, memory_id: 'current', project_id: 'p', status: 'active', score: 0.70 },
  ];
  assert.deepEqual(selectRecall(hits, { projectId: 'p', now: '2026-10-01T00:00:00Z' }).map(x => x.memory_id), ['current']);
});
```

## Task 7: M0-07 prospective acceptance, operations and release ruling (domínio: python+integracao; tipo: operacional; review: seguranca)

**Files:** Create `base/memoria/deploy/install-qdrant.sh` in product repo, `/home/axcel/cbs-lab/docs/operacao/qdrant-memoria.md`, `/home/axcel/cbs-lab/docs/analises/2026-10-01-memoria-mem0-aceite.md` and focused script smoke test in product repo. Do not publish or deploy to shared production.

**Interfaces:** `install-qdrant.sh` reads `QDRANT_API_KEY_FILE` (required existing mode-0600 secret file), `QDRANT_DATA_DIR` (required persistent directory) and `QDRANT_BIND_IP` (required loopback/private address); container name `cbs-mem0-qdrant`, image version/digest pinned in script, port 6333, restart policy. It rejects missing/unsafe inputs before Docker calls, never places the key in an argv/log, and repeat invocation keeps existing volume/container data. Produces signed-off or blocked release ruling with raw prospective cases, CPU/RAM/disk/network/latency/calls/cost measurements, restore trace and rollback trace. No automatic activation from a passing script alone.

- [ ] Before outputs, freeze new real post-development source sessions, task questions and reference answers for Claude and Codex with/without memory; include positive facts, negatives, human rule, correction, attribution, historical date and project isolation. Human reviewer records omission, unsupported claim, benefit and harm per arm.
- [ ] Exercise two authorized machines/CLIs against an isolated private authenticated Qdrant test instance, writer designation/transfer, retry after store-before-ACK crash, and correction. Freeze a backup, restore into a clean instance and verify active/history IDs and payload consistency. Guide states volume, network, auth, backup/restore, key rotation and capability limit of broad admin credentials.
- [ ] Write `base/memoria/deploy/install-qdrant.sh` with a pinned Qdrant image/version, persistent volume, private bind/network configuration, API key supplied only by environment/secret file with safe permissions, restart policy, idempotent non-destructive repeat run, and explicit backup/restore commands in the guide. Write a failing shell/Docker smoke test for re-run preserving a marker point and rejecting missing key/public bind; run RED then implement and run GREEN in isolated localhost Docker if available. Do not embed credentials or require target-server details. User will run the script on the server later.

Concrete RED shell test for `test/memoria-qdrant-install.sh`; this safety test runs without Docker, while the separate persistence smoke needs isolated Docker:

```bash
#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "$0")/.." && pwd)/base/memoria/deploy/install-qdrant.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
printf 'synthetic-test-key\n' > "$scratch/key"
chmod 600 "$scratch/key"
set +e
missing_output="$(QDRANT_API_KEY_FILE="$scratch/missing" QDRANT_DATA_DIR="$scratch/data" QDRANT_BIND_IP=127.0.0.1 bash "$script" 2>&1)"
missing_status=$?
public_output="$(QDRANT_API_KEY_FILE="$scratch/key" QDRANT_DATA_DIR="$scratch/data" QDRANT_BIND_IP=0.0.0.0 bash "$script" 2>&1)"
public_status=$?
set -e
test "$missing_status" -ne 0
test "$public_status" -ne 0
[[ "$missing_output" == *QDRANT_API_KEY_FILE* ]]
[[ "$public_output" == *QDRANT_BIND_IP* ]]
```
- [ ] Deliver a native PowerShell Windows validation/install harness for the recipient, covering runtime paths, NTFS ACLs, canonical Git aliases, process locks, native Claude/Codex trust/exclusion/hooks, durable crash/replay and optional AMD/DirectML. No Windows machine is available in the current environment: simulated tests must not be labeled native proof. Request execution of the concrete harness on the recipient's Windows after it is reviewable; keep that platform blocked until returned evidence passes. Qdrant `.sh` remains the Linux-server installer, not a Windows-client daemon.
- [ ] Measure p50/p95 and peak CPU/RAM/disk/network on clients and Qdrant for capture, extraction, E5, store, recall and replay; count Sol/Sonnet calls, tokens and cost. Compare measured values with 250 ms, 1,000 ms, 256 MiB, 4 calls, 5 candidates and 500 tokens. Base capacity advice on measurements, not invented RAM floor.
- [ ] Remove opt-in for a fresh session; verify claude-mem default returns for that project while Mem0 outbox/candidates remain inspectable and no automatic sync occurs. Re-run product `npm test`, operational E2E and security gate; dispatch `final_reviewer_sol` with `cobertura-de-testes` and `seguranca` lenses.
- [ ] Issue release ruling: block on any critical identity, attribution, time, precedence, human-rule or isolation failure; require at least one documented prospective task improved by memory and no material harm before recommending opt-in. Preserve reports/commits locally. Do not push, merge, publish or bump version.


## Task 8: M0-04/M0-06 Windows native security, identity and CLI fixture chain (domínio: node+integracao; review: seguranca)

**Authority:** approved PRD Windows target and M0-07 executable native harness; this is implementation of an existing requirement omitted behind unconditional platform guards, not a new provider or release relaxation. Read /home/axcel/cbs-lab/docs/decisoes/task-7-windows-boundary-decision.md. Task7 Important Windows finding remains open until the executable chain and actual native evidence exist.

**Ownership:** create minimal `base/memoria/windows-security.mjs` and its helper script if required; smallest Windows-only changes to `project-id.mjs`, `trust.mjs`, `native.mjs`, `launch.mjs`, focused tests and `test/memoria-windows-validation.ps1`. Preserve all Linux behavior and frozen Task6 correlation repairs. Do not touch broker/outbox/checkpoint/ledger/runtime/provision in this slice; document required interfaces for a subsequent portability slice.

**Requirements:**
- Before implementation, write the concrete slice design/interfaces and RED cases to the report from the existing decision and inspected code. Use canonical system tools and structured transport, never repository-selected executable/helper/secret.
- Windows private state operations verify current SID, owner, NTFS local volume, no reparse/junction/symlink or ambiguous UNC/device path, and DACL write/read permissions for the owner plus only explicitly justified system principals. Creation and reopen fail closed; mode/optional getuid is insufficient. No diagnostic emits keys/tokens/session contents.
- Canonical identity shared across provider/trust/native/launch covers drive spelling, case, mainRoot vs linked-worktree activeRoot, subdirs and safe aliases. Refuse unsupported ambiguous paths rather than guess identity; preserve Linux identifiers.
- Implement Windows-safe native hook command quoting and local fixture apply/verify/restore/exclusion/trust/launch checks with actual code, not a test-variable bypass of native_windows_unproved. No global CLI/profile/plugin mutation. Unknown/changed pre-existing config and leases preserved, rollback resumable. `activateProject`, capture and transport remain blocked until their remaining guards/security requirements and real native acceptance are satisfied.
- Windows-owned PowerShell fixture harness invokes these real low-level production controls, including native CLI startup/event probes when installed and legitimate trust is available; no implicit login/model calls or broad permission bypass. It records executed vs blocked_missing_implementation vs missing_prerequisite vs failed vs passed, versions/hashes and sanitized evidence. A guard return alone is not support PASS. Existing user CLI processes/profiles stay untouched.
- Keep CPU default bounded, no GPU/download/CLI extraction/account calls during development; optional DirectML remains unproved without corpus/native measurements. Qdrant server architecture unchanged.

**Verification:** meaningful RED/GREEN contract and hostile path/DACL parser cases on available host, PowerShell syntax/static checks and Linux regressions for touched boundaries on Node18/24; report simulated evidence separately. Do not label Linux mock/PowerShell parser as Windows proof. Do not repeat E5/Docker/fullnpm baselines. Gitleaks security gate records partial tools. Commit owned changes only; implementation report task-8-implementation-report.md contains exact files/tests/risks, remaining Task9 interfaces and native evidence requirements. No child agents. Release remains BLOCKED without real Windows/human/two-machine acceptance.

## Task 9: M0-04/M0-06 Windows persistence, IPC, runtime and executable acceptance fixture (domínio: node+python+integracao; review: seguranca)

**Authority/dependencies:** implement the remaining approved native Windows requirement after Task8 review closes and Task6 FIX5 releases the tree. Read workspace `task-9-portability-design.md` and `task-9-windows-activation-ruling.md`; the latter settles activation/fixture boundaries. Preserve every reviewed Linux repair and the existing formats, provider defaults and budgets.

**Integration rulings:** the native probe of reviewed `7728e9e` found Codex CLI hook values must be TOML sequences, not JSON serialized as a string. This shared Linux/Windows launch-wire repair is mandatory here; retain FIX5 source-selection, caller-argument and bound-session protections and cover the real parser without auth/model calls. Windows native settings use a private immutable per-launch overlay, held against write/delete until exit, rather than replacing existing project/global configuration. Preserve unrelated hooks/settings and refuse unproved managed-policy exclusion before credentials. Explicit launcher operation is already required by the approved correlation decision; direct CLI remains unbound/fail-open with no destination secret. Journaled mutation applies only to exclusive CBS state with replay before read, exact known bytes/identity and blocked/preserved ambiguous crashes. See progress rulings and Task9 report for primary platform contracts.

**Ownership:** Windows seams only in `provider`, `session-checkout`, `launch`, `checkpoint`, `transcript`, `outbox`, `ledger`, `extract-worker`, `extract-cli`, `candidates`, `review`, `broker`, `hook-recall`, `runtime`, `provision`, `setup` and `python/setup_runtime.py`; minimal extension of the reviewed Windows helper and focused tests/PowerShell fixture. No rewrite of ranking, IDs, Mem0 adapter or Qdrant installer. One writer, no children. Design and evidence go in `task-9-implementation-report.md`.

**Requirements:**
- Implement private SID/DACL/NTFS/no-reparse handle-bound reads, one-time session binding and process-crash-safe publication. Preserve source offsets, receipt-before-cursor order, pending replay, exclusive claims and 256 MiB allocated-budget accounting; never reclaim a lock by PID/mtime/unlink. Use a permanent kernel-handle lock with ownership and release acknowledgement, no Python/model in capture.
- For Windows IPC use numeric loopback only, owner-private discovery/capability and domain-separated mutual challenge/HMAC before sending any destination secret. Reuse the binary framing and one bounded serialized E5; per-operation session/trust/DNS/key validation remains. Fake/stale server and incomplete/slow handshake fail closed under deadline. No socket/pipe name alone is an authorization boundary.
- Port extraction/review/runtime at their existing guarded seams, using verified installed executables and protected pins/artifacts, not repository/PATH selection. Preserve four calls/session, five candidates/checkpoint, source-bound manual review and explicit Sonnet/no-fallback routing. CPU remains default; optional DirectML remains unproved. No production/model/GPU download is required by this implementation task.
- Distinguish policy from operational checks: public `activateProject` and `launchCli` for ordinary Windows projects retain explicit `windows_release_unproved` until a later reviewed change with real native evidence. No env/flag/editable PASS marker bypass. Operational capture/binding/outbox/IPC/replay must contain real Windows implementations and fail by actual missing capability/identity, rather than an unconditional platform stub.
- The owned temporary NTFS fixture invokes the same production transaction/launcher core (or the smallest direct production primitives), with new protected checkout/state/profile, legitimate local destination trust and native CLI trust. It cannot target an arbitrary existing project or profile. It executes actual hooks/capture/crash/replay/recall when native prerequisites are supplied; Linux simulation/static parsing is never Windows PASS. Cleanup touches only directly owned resources and preserves concurrent edits or pending records.
- Harness records `passed`, `failed`, `missing_prerequisite`, `blocked_missing_implementation` separately, plus versions/hashes/resources/deadlines. Missing native target is an external gate after implementation, never an excuse for absent pipeline. Keep two-machine, prospective-human-benefit/no-harm and Windows support acceptance open until genuine returned evidence.

**Verification:** RED/GREEN for mutual authentication before secret, bound session and denied overrides, receipt/cursor/replay, protected file contention and lost kernel lock; covering Linux regressions Node18/24 and PowerShell static checks, no repeated fullnpm/E5/model/Docker baseline. Security gate truthfully partial where disabled tools remain disabled. Commit only owned files and report exact runnable native commands and residual gates. Root runs one final full suite after code stabilizes, then final whole-branch review. No push/merge/publish/deploy/version changes.
