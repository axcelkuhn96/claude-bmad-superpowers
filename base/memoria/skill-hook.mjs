import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectConfiguration, resolveProject } from './provider.mjs';
import { identifyProject } from './project-id.mjs';
import { verifyNativeCapture } from './native.mjs';
import { readLocalTrust, sameTrustTuple, trustTuple } from './trust.mjs';
import { readSessionCheckout } from './session-checkout.mjs';
import { readOwner, readExtractor } from './policy.mjs';
import { ensureBrokerReady } from './broker-start.mjs';
import { searchProject } from './bridge.mjs';
import { selectRecall } from './context.mjs';
import { recordRecallWindow } from './hook-recall.mjs';
import { readQdrantSecret } from './qdrant-key.mjs';
import { nativeProfile } from './native-profile.mjs';

const unavailable = reason => ({ kind: 'unavailable', reason });
const output = text => ({ hookSpecificOutput: { hookEventName: 'PreToolUse',
  additionalContext: `CBS Mem0: ${text}` } });
const failure = reason => output(`unavailable:${/^[a-z][a-z0-9_]{0,47}$/.test(reason ?? '')
  ? reason : 'error'}`);

export function parseSkillTrigger(command) {
  if (command === 'cbs memoria hook start') return { action: 'start' };
  const match = /^cbs memoria hook search ([A-Za-z0-9_-]{2,5462})$/.exec(command ?? '');
  if (!match || match[1].length % 4 === 1) return null;
  const bytes = Buffer.from(match[1], 'base64url');
  if (!bytes.length || bytes.length > 4096 || bytes.toString('base64url') !== match[1]) return null;
  const query = bytes.toString('utf8');
  if (Buffer.from(query).compare(bytes) !== 0 || !query.trim()) return null;
  return { action: 'search', query };
}

export async function authenticateSkillHook({ cli, payload, stateRoot } = {}) {
  if (process.platform !== 'win32' && !process.getuid) return unavailable('native_windows_unproved');
  if (!['claude', 'codex'].includes(cli) || payload?.hook_event_name !== 'PreToolUse' ||
      payload.tool_name !== 'Bash' || typeof payload.cwd !== 'string' ||
      typeof payload.session_id !== 'string' || !payload.session_id || payload.session_id.length > 256 ||
      typeof payload.transcript_path !== 'string' ||
      typeof payload.tool_use_id !== 'string' || !payload.tool_use_id ||
      payload.tool_use_id.length > 256) return unavailable('invalid_hook_payload');
  const current = await resolveProject(payload.cwd, payload.session_id, { stateRoot });
  if (current.provider !== 'mem0') return unavailable(current.reason ?? 'not_mem0');
  const configured = await inspectConfiguration(payload.cwd, { stateRoot });
  if (configured.provider !== 'mem0' || configured.projectId !== current.projectId ||
      configured.projectRoot !== current.projectRoot ||
      configured.embeddingFingerprint !== current.embeddingFingerprint ||
      JSON.stringify(configured.destination) !== JSON.stringify(current.destination)) return unavailable('session_changed');
  const scope = await identifyProject(payload.cwd);
  if (scope.kind !== 'git' || scope.projectRoot !== current.projectRoot) return unavailable('unsupported_git');
  const native = await verifyNativeCapture(cli === 'codex' ? scope.activeRoot : current.projectRoot,
    { cli, stateRoot, projectRoot: current.projectRoot });
  if (native.kind !== 'verified') return unavailable(native.reason);
  const trust = await readLocalTrust(current.stateDir);
  if (!sameTrustTuple(trustTuple(current), trust)) {
    return unavailable('trust_changed');
  }
  const owner = await readOwner(current, cli, nativeProfile(cli));
  const extractor = await readExtractor(current);
  if (owner?.kind === 'blocked' || extractor?.kind === 'blocked' ||
      (owner?.ownerId ?? null) !== (current.ownerId ?? null)) return unavailable('local_policy_changed');
  const transcript = payload.transcript_path;
  if (!path.isAbsolute(transcript) || !(cli === 'claude'
    ? path.basename(transcript) === `${payload.session_id}.jsonl`
    : path.basename(transcript).endsWith(`${payload.session_id}.jsonl`))) return unavailable('transcript_session_mismatch');
  try {
    const stat = await fs.lstat(transcript);
    if (!stat.isFile() || stat.uid !== process.getuid()) return unavailable('unsafe_transcript');
  } catch (error) { if (error.code !== 'ENOENT') return unavailable('unsafe_transcript'); }
  const checkout = await readSessionCheckout(current.stateDir, cli, payload.session_id);
  if (checkout.kind !== 'bound' || checkout.nativeRoot !== scope.activeRoot ||
      checkout.projectRoot !== current.projectRoot || checkout.projectId !== current.projectId) {
    return unavailable(checkout.reason ?? 'session_checkout_changed');
  }
  return { kind: 'bound', current, cwd: payload.cwd, sessionId: payload.session_id, cli };
}

export async function skillHook(cli, payload, { stateRoot, authenticate = authenticateSkillHook,
  ready = ensureBrokerReady, search = searchProject, recordWindow = recordRecallWindow,
  now = () => new Date().toISOString(), readSecret = readQdrantSecret } = {}) {
  if (payload?.tool_name !== 'Bash' || payload.hook_event_name !== 'PreToolUse') return null;
  const trigger = parseSkillTrigger(payload.tool_input?.command);
  if (!trigger || typeof payload.tool_use_id !== 'string' || !payload.tool_use_id) return null;
  const deadline = Date.now() + 9000;
  try {
    const binding = await authenticate({ cli, payload, stateRoot });
    if (binding.kind !== 'bound') return failure(binding.reason ?? 'unbound');
    const startupMs = Math.min(7000, deadline - Date.now() - 1000);
    if (startupMs <= 0) return failure('deadline');
    const opened = await ready(binding.cwd, { stateRoot,
      bootstrapSessionId: binding.sessionId, deadlineMs: startupMs });
    if (opened.kind !== 'ready') return failure(opened.reason ?? 'worker_cold');
    if (trigger.action === 'start') return output('ready');
    const searchMs = Math.min(5000, deadline - Date.now() - 1000);
    if (searchMs <= 0) return failure('deadline');
    const answer = await search({ cwd: binding.cwd, sessionId: binding.sessionId,
      projectId: binding.current.projectId, query: trigger.query }, readSecret,
    { stateRoot, deadlineMs: searchMs, ownerId: binding.current.ownerId });
    if (answer.kind !== 'items') return answer.kind === 'abstain'
      ? output('abstain') : failure(answer.reason ?? 'search_failed');
    const selected = selectRecall(answer.items, { projectId: binding.current.projectId,
      ownerId: binding.current.ownerId, now: now() });
    if (!selected.length) return output('abstain');
    const start = performance.now();
    const window = await recordWindow({ stateDir: binding.current.stateDir, cli,
      sessionId: binding.sessionId, eligible: selected,
      remaining: () => Math.min(1000 - (performance.now() - start), deadline - Date.now()) });
    return window.kind === 'items' ? output(window.text) : window.kind === 'abstain'
      ? output('abstain') : failure(window.reason ?? 'selection');
  } catch { return failure('error'); }
}
