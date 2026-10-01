import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectConfiguration, initializeSession, resolveProject } from './provider.mjs';
import { verifyNativeCapture } from './native.mjs';
import { createOutbox } from './outbox.mjs';
import { parsePersistedSlice, POLICY_VERSION } from './transcript.mjs';
import { readLocalTrust, trustTuple } from './trust.mjs';

const events = { claude: new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'SessionEnd']),
  codex: new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) };
const blocked = reason => ({ kind: 'blocked', reason });

export async function captureEvent({ cli, event, payload, stateRoot, installedPlugin } = {}) {
  if (!events[cli]?.has(event) || payload?.hook_event_name !== event ||
      typeof payload.cwd !== 'string' || typeof payload.session_id !== 'string' ||
      typeof payload.transcript_path !== 'string') return blocked('invalid_hook_payload');
  if (process.platform === 'win32' || !process.getuid) return blocked('native_windows_unproved');
  const options = { stateRoot };
  const resolution = event === 'SessionStart'
    ? await inspectConfiguration(payload.cwd, options) : await resolveProject(payload.cwd, payload.session_id, options);
  if (resolution.provider === 'claude-mem' || resolution.reason === 'not_mem0' ||
      resolution.reason === 'unsupported_git') return { kind: 'pass_through' };
  if (resolution.provider !== 'mem0' && resolution.reason !== 'fresh_session') return blocked(resolution.reason ?? 'unresolved_session');
  const current = resolution.provider === 'mem0' ? resolution : await inspectConfiguration(payload.cwd, options);
  if (current.provider !== 'mem0') return blocked(current.reason ?? 'unresolved_session');
  const native = await verifyNativeCapture(current.projectRoot, { cli, stateRoot, installedPlugin });
  if (native.kind !== 'verified') return blocked(native.reason);
  const trust = await readLocalTrust(current.stateDir);
  if (!trust || Object.entries(trustTuple(current)).some(([key, value]) => trust[key] !== value)) {
    return blocked('trust_changed');
  }
  const session = event === 'SessionStart'
    ? await initializeSession(payload.cwd, payload.session_id, { ...options, event }) : resolution;
  if (session.provider !== 'mem0') return blocked(session.reason ?? 'unresolved_session');
  const transcriptPath = payload.transcript_path;
  const basename = path.basename(transcriptPath);
  if (!path.isAbsolute(transcriptPath) || !(cli === 'claude'
    ? basename === `${payload.session_id}.jsonl` : basename.endsWith(`${payload.session_id}.jsonl`))) {
    return blocked('transcript_session_mismatch');
  }
  let stat;
  try { stat = await fs.lstat(transcriptPath); }
  catch { return blocked('missing_transcript'); }
  if (!stat.isFile() || stat.uid !== process.getuid()) return blocked('unsafe_transcript');
  const outbox = createOutbox(session.stateDir);
  let { queuedEnd } = await outbox.cursor(cli, payload.session_id);
  let last = { kind: 'no_complete_bytes', queuedEnd };
  while (queuedEnd < stat.size) {
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
      end: parsed.lastCompleteByte, sliceHash, messages: parsed.messages },
    { projectId: session.projectId, policyVersion: POLICY_VERSION });
    if (last.kind !== 'queued' && last.kind !== 'acked') return last;
    queuedEnd = parsed.lastCompleteByte;
  }
  return last;
}
