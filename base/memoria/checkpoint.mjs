import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectConfiguration, initializeSession, resolveProject } from './provider.mjs';
import { verifyNativeCapture } from './native.mjs';
import { createOutbox } from './outbox.mjs';
import { parsePersistedSlice, POLICY_VERSION } from './transcript.mjs';
import { readLocalTrust, sameTrustTuple, trustTuple } from './trust.mjs';
import { identifyProject } from './project-id.mjs';
import { bindLaunch, resolveBoundLaunch } from './launch.mjs';
import { recordSessionCheckout, readSessionCheckout } from './session-checkout.mjs';
import { readWindowsBinary } from './windows-security.mjs';

const events = { claude: new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'SessionEnd']),
  codex: new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) };
const blocked = reason => ({ kind: 'blocked', reason });

export async function captureEvent({ cli, event, payload, stateRoot, installedPlugin } = {}) {
  if (!events[cli]?.has(event) || payload?.hook_event_name !== event ||
      typeof payload.cwd !== 'string' || typeof payload.session_id !== 'string' ||
      typeof payload.transcript_path !== 'string') return blocked('invalid_hook_payload');
  if (process.platform !== 'win32' && !process.getuid) return blocked('native_windows_unproved');
  if (process.platform === 'win32' && !/^[a-f0-9]{64}$/.test(process.env.CBS_MEMORIA_LAUNCH_ID ?? '')) {
    return blocked('unbound');
  }
  const options = { stateRoot };
  const resolution = event === 'SessionStart'
    ? await inspectConfiguration(payload.cwd, options) : await resolveProject(payload.cwd, payload.session_id, options);
  if (resolution.provider === 'claude-mem' || resolution.reason === 'not_mem0' ||
      resolution.reason === 'unsupported_git') return { kind: 'pass_through' };
  if (resolution.provider !== 'mem0' && resolution.reason !== 'fresh_session') return blocked(resolution.reason ?? 'unresolved_session');
  const current = resolution.provider === 'mem0' ? resolution : await inspectConfiguration(payload.cwd, options);
  if (current.provider !== 'mem0') return blocked(current.reason ?? 'unresolved_session');
  const scope = await identifyProject(payload.cwd);
  if (scope.kind !== 'git' || scope.projectRoot !== current.projectRoot) return blocked('unsupported_git');
  const native = await verifyNativeCapture(cli === 'codex' ? scope.activeRoot : current.projectRoot,
    { cli, stateRoot, installedPlugin, projectRoot: current.projectRoot,
      ...(process.platform === 'win32' ? { launchToken: process.env.CBS_MEMORIA_LAUNCH_ID,
        profile: cli === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR } : {}) });
  if (native.kind !== 'verified') return blocked(native.reason);
  const trust = await readLocalTrust(current.stateDir);
  if (!sameTrustTuple(trustTuple(current), trust)) {
    return blocked('trust_changed');
  }
  const session = event === 'SessionStart'
    ? await initializeSession(payload.cwd, payload.session_id, { ...options, event, cli,
      profile: cli === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR }) : resolution;
  if (session.provider !== 'mem0') return blocked(session.reason ?? 'unresolved_session');
  const transcriptPath = payload.transcript_path;
  const basename = path.basename(transcriptPath);
  if (!path.isAbsolute(transcriptPath) || !(cli === 'claude'
    ? basename === `${payload.session_id}.jsonl` : basename.endsWith(`${payload.session_id}.jsonl`))) {
    return blocked('transcript_session_mismatch');
  }
  let stat;
  try { stat = await fs.lstat(transcriptPath); }
  catch (error) {
    if (error.code !== 'ENOENT' || !['SessionStart', 'UserPromptSubmit'].includes(event)) {
      return blocked(error.code === 'ENOENT' ? 'missing_transcript' : 'unsafe_transcript');
    }
  }
  if (stat && process.platform === 'win32') {
    if (!stat.isFile()) return blocked('unsafe_transcript');
    try {
      const opened = await readWindowsBinary(transcriptPath, { length: 0, privateState: false });
      stat = { size: opened.size, fileId: opened.fileId };
    } catch { return blocked('unsafe_transcript'); }
  } else if (stat && (!stat.isFile() || stat.uid !== process.getuid())) return blocked('unsafe_transcript');
  const checkout = event === 'SessionStart'
    ? await recordSessionCheckout(session, cli, payload.session_id, scope.activeRoot)
    : await readSessionCheckout(session.stateDir, cli, payload.session_id);
  if (checkout.kind !== 'bound' || checkout.nativeRoot !== scope.activeRoot ||
      checkout.projectRoot !== session.projectRoot || checkout.projectId !== session.projectId) {
    return blocked(checkout.reason ?? 'session_checkout_changed');
  }
  if (event === 'SessionStart' && process.env.CBS_MEMORIA_LAUNCH_ID) {
    const binding = await bindLaunch(process.env.CBS_MEMORIA_LAUNCH_ID, cli, payload.cwd, payload.session_id, { stateRoot });
    if (binding.kind !== 'bound') return blocked(binding.reason);
  }
  if (process.platform === 'win32') {
    const binding = await resolveBoundLaunch(process.env.CBS_MEMORIA_LAUNCH_ID, cli, { stateRoot });
    if (binding.kind !== 'bound' || binding.nativeSessionId !== payload.session_id) {
      return blocked(binding.reason ?? 'unbound');
    }
  }
  const outbox = createOutbox(session.stateDir);
  let { queuedEnd } = await outbox.cursor(cli, payload.session_id);
  let last = { kind: 'no_complete_bytes', queuedEnd };
  while (stat && queuedEnd < stat.size) {
    let parsed;
    try {
      parsed = await parsePersistedSlice({ cli, transcriptPath, start: queuedEnd,
        sessionId: payload.session_id, expectedFile: stat });
    } catch (error) {
      if (['oversized_transcript_record', 'unsafe_transcript', 'transcript_session_mismatch'].includes(error.message) ||
          error.code === 'ELOOP') return blocked(error.code === 'ELOOP' ? 'unsafe_transcript' : error.message);
      throw error;
    }
    if (parsed.lastCompleteByte === queuedEnd) return last;
    const sliceHash = createHash('sha256').update(parsed.completeBytes).digest('hex');
    last = await outbox.enqueueCheckpoint({ cli, sessionId: payload.session_id, start: queuedEnd,
      end: parsed.lastCompleteByte, sliceHash,
      messages: parsed.messages.map(message => message.origin === 'human' && session.ownerId
        ? { ...message, ownerId: session.ownerId } : message) },
    { projectId: session.projectId, policyVersion: POLICY_VERSION });
    if (last.kind !== 'queued' && last.kind !== 'acked') return last;
    queuedEnd = parsed.lastCompleteByte;
  }
  return last;
}
