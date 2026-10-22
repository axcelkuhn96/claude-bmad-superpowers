import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inspectConfiguration, initializeSession, resolveProject,
  refreshSessionPolicyForCapture } from './provider.mjs';
import { verifyNativeCapture } from './native.mjs';
import { createOutbox } from './outbox.mjs';
import { parsePersistedSlice, POLICY_VERSION } from './transcript.mjs';
import { readLocalTrust, sameTrustTuple, trustTuple } from './trust.mjs';
import { identifyProject } from './project-id.mjs';
import { bindLaunch, resolveBoundLaunch } from './launch.mjs';
import { bindSessionCheckoutProfile, recordSessionCheckout,
  readSessionCheckout } from './session-checkout.mjs';
import { readWindowsBinary } from './windows-security.mjs';
import { nativeProfile } from './native-profile.mjs';
import { currentExtractionSchedule } from './policy.mjs';
import { withProjectLock } from './ledger.mjs';
import { formatHandoff } from './handoff-format.mjs';
import { saveHandoff } from './handoff-state.mjs';

const events = { claude: new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'SessionEnd']),
  codex: new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'Interrupt', 'SessionEnd']) };
const blocked = reason => ({ kind: 'blocked', reason });
const flushEvents = new Set(['PreCompact', 'SessionEnd', 'Interrupt']);
const handoffProofs = new WeakMap();

async function completeTranscriptEnd(transcriptPath, stat) {
  if (!stat) return 0;
  const maxWindow = 4 * 1024 * 1024;
  if (process.platform === 'win32') {
    for (let end = stat.size; end > 0;) {
      const start = Math.max(0, end - maxWindow);
      const observed = await readWindowsBinary(transcriptPath,
        { offset: start, length: end - start, privateState: false });
      if (observed.fileId !== stat.fileId || observed.size < stat.size ||
          observed.bytes.length !== end - start) throw new Error('unsafe_transcript');
      const newline = observed.bytes.lastIndexOf(10);
      if (newline >= 0) return start + newline + 1;
      if (stat.size >= maxWindow) throw new Error('oversized_transcript_record');
      break;
    }
    return 0;
  }
  const handle = await fs.open(transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size < stat.size) {
      throw new Error('unsafe_transcript');
    }
    for (let end = stat.size; end > 0;) {
      const start = Math.max(0, end - maxWindow);
      const bytes = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) throw new Error('unsafe_transcript');
      const newline = bytes.lastIndexOf(10);
      if (newline >= 0) return start + newline + 1;
      if (stat.size >= maxWindow) throw new Error('oversized_transcript_record');
      break;
    }
    return 0;
  } finally { await handle.close(); }
}

export async function captureEvent({ cli, event, payload, stateRoot, installedPlugin } = {}) {
  const capturedAt = new Date().toISOString();
  const noTranscriptFlush = cli === 'codex' && flushEvents.has(event) &&
    payload?.transcript_path === null;
  if (!events[cli]?.has(event) || payload?.hook_event_name !== event ||
      typeof payload.cwd !== 'string' || typeof payload.session_id !== 'string' ||
      (typeof payload.transcript_path !== 'string' && !noTranscriptFlush)) return blocked('invalid_hook_payload');
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
  const native = await verifyNativeCapture(scope.activeRoot,
    { cli, stateRoot, installedPlugin, projectRoot: current.projectRoot,
      ...(process.platform === 'win32' ? { launchToken: process.env.CBS_MEMORIA_LAUNCH_ID,
        profile: nativeProfile(cli) } : {}) });
  if (native.kind !== 'verified') return blocked(native.reason);
  const trust = await readLocalTrust(current.stateDir);
  if (!sameTrustTuple(trustTuple(current), trust)) {
    return blocked('trust_changed');
  }
  let session = event === 'SessionStart'
    ? await initializeSession(payload.cwd, payload.session_id, { ...options, event, cli,
      profile: nativeProfile(cli) }) : resolution;
  if (session.provider !== 'mem0') return blocked(session.reason ?? 'unresolved_session');
  const transcriptPath = payload.transcript_path;
  const basename = typeof transcriptPath === 'string' ? path.basename(transcriptPath) : null;
  if (!noTranscriptFlush && (!path.isAbsolute(transcriptPath) || !(cli === 'claude'
    ? basename === `${payload.session_id}.jsonl` : basename.endsWith(`${payload.session_id}.jsonl`)))) {
    return blocked('transcript_session_mismatch');
  }
  if (!noTranscriptFlush && !path.relative(session.stateDir, transcriptPath).startsWith(`..${path.sep}`) &&
      !path.isAbsolute(path.relative(session.stateDir, transcriptPath))) {
    return blocked('unsafe_transcript');
  }
  let stat;
  if (!noTranscriptFlush) {
    try { stat = await fs.lstat(transcriptPath); }
    catch (error) {
      if (error.code !== 'ENOENT' || !['SessionStart', 'UserPromptSubmit'].includes(event)) {
        return blocked(error.code === 'ENOENT' ? 'missing_transcript' : 'unsafe_transcript');
      }
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
    ? await recordSessionCheckout(session, cli, payload.session_id, scope.activeRoot, nativeProfile(cli))
    : await readSessionCheckout(session.stateDir, cli, payload.session_id);
  if (checkout.kind !== 'bound' || checkout.nativeRoot !== scope.activeRoot ||
      checkout.projectRoot !== session.projectRoot || checkout.projectId !== session.projectId) {
    return blocked(checkout.reason ?? 'session_checkout_changed');
  }
  const profiled = await bindSessionCheckoutProfile(session.stateDir, cli,
    payload.session_id, nativeProfile(cli));
  if (profiled.kind !== 'bound') return blocked(profiled.reason ?? 'session_checkout_changed');
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
  session = await refreshSessionPolicyForCapture(payload.cwd, payload.session_id,
    { stateRoot, cli, profile: nativeProfile(cli) });
  if (session.provider !== 'mem0') return blocked(session.reason ?? 'local_policy_changed');
  if (session.extractor?.autoPublish === true) {
    session = { ...session,
      extractor: await currentExtractionSchedule(session, session.extractor) };
  }
  const outbox = createOutbox(session.stateDir);
  const identity = checkout.handoffIdentity;
  const handoffBound = identity && identity.ownerId === session.ownerId &&
    identity.projectId === session.projectId && identity.projectRoot === session.projectRoot &&
    identity.nativeRoot === scope.activeRoot && identity.sourceSessionId === payload.session_id &&
    identity.cli === cli;
  const sourceRefs = [];
  const finish = result => {
    if (handoffBound && result && !['blocked', 'pass_through', 'full'].includes(result.kind)) {
      handoffProofs.set(result, { cli, event, sessionId: payload.session_id,
        cwd: payload.cwd, transcriptPath, stateDir: session.stateDir,
        identity, sourceRefs: [...sourceRefs], capturedAt });
    }
    return result;
  };
  const conversation = session.extractor?.autoPublish === true &&
    session.extractor.mode === 'conversation';
  const flushStage = () => outbox.flushConversationStage({ cli, sessionId: payload.session_id,
    projectId: session.projectId, policyVersion: POLICY_VERSION, event,
    conversationTurns: session.extractor.conversationTurns });
  if (session.extractor?.autoPublish === true && !stat) {
    if (conversation && noTranscriptFlush) {
      const proof = await outbox.readFutureBaseline({ cli, sessionId: payload.session_id,
        projectId: session.projectId, ownerId: session.ownerId,
        consentHash: session.extractor.autoPublishConsent?.consentHash,
        policyVersion: POLICY_VERSION });
      if (proof.kind !== 'baselined') return proof;
      return finish(await flushStage());
    }
    const { queuedEnd } = await outbox.cursor(cli, payload.session_id);
    return finish({ kind: 'no_complete_bytes', queuedEnd });
  }
  let baseline;
  if (session.extractor?.autoPublish === true) {
    let cutoffEnd;
    try { cutoffEnd = await completeTranscriptEnd(transcriptPath, stat); }
    catch (error) { return blocked(error.message === 'oversized_transcript_record'
      ? error.message : 'unsafe_transcript'); }
    try {
      baseline = await outbox.ensureFutureBaseline({ cli, sessionId: payload.session_id,
        projectId: session.projectId, ownerId: session.ownerId,
        consentHash: session.extractor.autoPublishConsent?.consentHash,
        policyVersion: POLICY_VERSION, cutoffEnd, initialSize: stat.size });
    } catch { return blocked('future_baseline_unavailable'); }
    if (baseline.kind !== 'baselined') return baseline;
  }
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
    if (parsed.lastCompleteByte === queuedEnd) break;
    const sliceHash = createHash('sha256').update(parsed.completeBytes).digest('hex');
    const slice = { cli, sessionId: payload.session_id, start: queuedEnd,
      end: parsed.lastCompleteByte, sliceHash,
      messages: parsed.messages.filter(message => !baseline || message.start >= baseline.initialSize)
        .map(message => message.origin === 'human' && session.ownerId
          ? { ...message, ownerId: session.ownerId } : message) };
    const queued = conversation
      ? await outbox.enqueueConversationSlice(slice,
        { projectId: session.projectId, policyVersion: POLICY_VERSION },
        { event, conversationTurns: session.extractor.conversationTurns })
      : await outbox.enqueueCheckpoint(slice,
        { projectId: session.projectId, policyVersion: POLICY_VERSION });
    if (!['queued', 'acked', 'processed', 'staged'].includes(queued.kind)) return queued;
    sourceRefs.push(queued.operationId ?? null);
    if (last.kind !== 'queued' || queued.kind === 'queued') last = queued;
    queuedEnd = parsed.lastCompleteByte;
  }
  if (conversation && flushEvents.has(event)) {
    const flushed = await flushStage();
    if (['queued', 'acked', 'processed'].includes(flushed.kind)) {
      sourceRefs.push(flushed.operationId);
      return finish(flushed);
    }
    if (!['no_complete_pairs', 'staged'].includes(flushed.kind)) return flushed;
  }
  if (conversation && event === 'Stop' && last.kind === 'no_complete_bytes') {
    return finish({ kind: 'staged', queuedEnd });
  }
  return finish(last);
}

// A result object gets authority only from the completed native capture path.
// Copying it or adding request-side flags cannot manufacture this proof.
export function authenticatedHandoffCapture({ cli, event, payload, result } = {}) {
  const proof = handoffProofs.get(result);
  return proof && proof.cli === cli && proof.event === event &&
    proof.sessionId === payload?.session_id && proof.cwd === payload.cwd &&
    proof.transcriptPath === payload.transcript_path ? proof : null;
}

const evidenceFile = (stateDir, cli, sessionId) => path.join(stateDir, 'sessions',
  `${createHash('sha256').update(JSON.stringify([cli, sessionId])).digest('hex')}.handoff-evidence.json`);

async function readHandoffEvidence(file, identity, allowExpired = false) {
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid() ||
        (before.mode & 0o077) || before.size > 8192) return null;
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino ||
          opened.size !== before.size) return null;
      const value = JSON.parse(await handle.readFile('utf8'));
      return value.checkoutFingerprint === identity.checkoutFingerprint &&
        value.ownerId === identity.ownerId &&
        value.cli === identity.cli && typeof value.sessionId === 'string' &&
        file === evidenceFile(path.dirname(path.dirname(file)), value.cli, value.sessionId) &&
        Number.isFinite(Date.parse(value.at)) &&
        (allowExpired || Date.now() - Date.parse(value.at) <= 7 * 24 * 60 * 60 * 1000) &&
        Array.isArray(value.messages) && value.messages.length <= 2 &&
        value.messages.every(item => ['human', 'assistant'].includes(item.origin) &&
          typeof item.text === 'string' && Buffer.byteLength(item.text) <= 160 &&
          /^[a-f0-9]{64}$/.test(item.proofHash ?? '')) ? value : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

async function cleanupHandoffEvidence(stateDir, identity, began) {
  const dir = path.join(stateDir, 'sessions');
  const cursor = path.join(dir, `${createHash('sha256').update(JSON.stringify([
    identity.ownerId, identity.checkoutFingerprint])).digest('hex')}.handoff-gc-cursor`);
  let after = '';
  try {
    const before = await fs.lstat(cursor);
    if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 0o077) ||
        before.size > 128) return;
    const handle = await fs.open(cursor, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { after = (await handle.readFile('utf8')).trim(); }
    finally { await handle.close(); }
    if (after && !/^[a-f0-9]{64}\.handoff-evidence\.json$/.test(after)) return;
  } catch (error) { if (error.code !== 'ENOENT') return; }
  if (performance.now() - began > 750) return;
  const names = (await fs.readdir(dir)).filter(name =>
    /^[a-f0-9]{64}\.handoff-evidence\.json$/.test(name)).sort();
  if (!names.length || performance.now() - began > 750) return;
  const first = names.findIndex(name => name > after);
  const ordered = first < 0 ? names : [...names.slice(first), ...names.slice(0, first)];
  let last = after;
  for (const name of ordered.slice(0, 128)) {
    if (performance.now() - began > 750) break;
    const file = path.join(dir, name);
    const value = await readHandoffEvidence(file, identity, true);
    if (performance.now() - began > 750) break;
    if (value && Date.now() - Date.parse(value.at) > 7 * 24 * 60 * 60 * 1000) {
      await fs.rm(file, { force: true });
    }
    last = name;
  }
  if (last !== after && performance.now() - began <= 750) {
    const temporary = `${cursor}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${last}\n`, { mode: 0o600, flag: 'wx' });
    try { await fs.rename(temporary, cursor); }
    catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  }
}

async function writeHandoffEvidence(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  catch (error) { await handle.close(); await fs.rm(temporary, { force: true }); throw error; }
  await handle.close();
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function updateHandoffFromCapture({ cli, event, payload, result,
  stateRoot: _stateRoot, began = performance.now() } = {}) {
  const proof = authenticatedHandoffCapture({ cli, event, payload, result });
  const hasTime = () => performance.now() - began < 800;
  if (!proof || process.platform === 'win32' || !hasTime()) return null;
  const lockName = `handoff-${createHash('sha256').update(JSON.stringify([cli, proof.sessionId]))
    .digest('hex').slice(0, 32)}.lock`;
  try {
    return await withProjectLock(proof.stateDir, async () => {
      const file = evidenceFile(proof.stateDir, cli, proof.sessionId);
      const prior = await readHandoffEvidence(file, proof.identity);
      if (!hasTime()) return null;
      if (!prior && await fs.lstat(file).then(() => true, error =>
        error.code === 'ENOENT' ? false : Promise.reject(error))) return null;
      if (!hasTime()) return null;
      if (prior && Date.parse(proof.capturedAt) < Date.parse(prior.at)) return null;
      let messages = event === 'SessionStart' ? [] : [...(prior?.messages ?? [])];
      let operationId = prior?.operationId;
      let hadHuman = false;
      const outbox = createOutbox(proof.stateDir);
      for (const ref of [...new Set(proof.sourceRefs)]) {
        if (!hasTime()) return null;
        const source = await outbox.handoffSource({ cli, sessionId: proof.sessionId,
          projectId: proof.identity.projectId, ownerId: proof.identity.ownerId,
          operationId: ref });
        if (!hasTime()) return null;
        if (source.kind !== 'source') continue;
        operationId = source.operationId;
        for (const item of source.messages) {
          if (item.origin === 'human') {
            hadHuman = true;
            messages = [];
          }
          if (typeof item.text !== 'string' || Buffer.byteLength(item.text) > 160) continue;
          // Persist only excerpts the formatter itself permits. Rejected source
          // text already lives in the authenticated outbox and is not copied.
          const screened = formatHandoff({ ...proof.identity,
            checkpoint: { operationId, messages: [item] }, now: proof.capturedAt });
          if (!screened.markdown.includes(`“${item.text.trim()}”`)) continue;
          if (item.origin === 'human') messages = [item];
          else if (item.origin === 'assistant' && item.finalVisible === true) {
            messages = [...messages.filter(message => message.origin === 'human'), item];
          }
        }
      }
      if (hadHuman && !messages.some(message => message.origin === 'human')) messages = [];
      const value = { checkoutFingerprint: proof.identity.checkoutFingerprint,
        ownerId: proof.identity.ownerId, cli, sessionId: proof.sessionId,
        at: proof.capturedAt, operationId,
        messages: messages.slice(-2) };
      if (!hasTime()) return null;
      await writeHandoffEvidence(file, value);
      if (!hasTime()) return null;
      let handoff;
      if (operationId && messages.length) {
        handoff = formatHandoff({ ...proof.identity,
          checkpoint: { operationId, messages }, now: proof.capturedAt });
      }
      if (hadHuman && !handoff && !['SessionStart', 'UserPromptSubmit'].includes(event)) {
        // Stop/terminal saves preserve an absent handoff; clear it as an active turn first.
        const cleared = await saveHandoff(proof.stateDir, { identity: proof.identity,
          event: 'UserPromptSubmit', at: proof.capturedAt, hasTime });
        if (cleared.kind !== 'saved') return cleared;
      }
      const saved = await saveHandoff(proof.stateDir, { identity: proof.identity,
        handoff, event, at: proof.capturedAt, hasTime });
      if (saved.kind === 'saved' && hasTime() && ['SessionEnd', 'Interrupt'].includes(event)) {
        await fs.rm(file, { force: true }).catch(() => {});
      } else if (saved.kind === 'saved' && hasTime() && event === 'SessionStart') {
        await cleanupHandoffEvidence(proof.stateDir, proof.identity, began).catch(() => {});
      }
      return saved;
    }, lockName, 25);
  } catch { return null; }
}
