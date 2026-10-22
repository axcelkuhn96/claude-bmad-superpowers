import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brokerEndpointStatus } from './broker.mjs';
import { inspectConfiguration, resolveProject } from './provider.mjs';
import { readLocalTrust, sameTrustTuple, trustTuple } from './trust.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const starting = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function ensureBrokerReady(cwd, { stateRoot, bootstrapSessionId,
  deadlineMs = 30000, spawnBroker = spawn } = {}) {
  if (process.platform === 'win32' || !process.getuid) return blocked('native_windows_unproved');
  const root = stateRoot ?? path.join(os.homedir(), '.local', 'state', 'cbs', 'memoria');
  const deadline = Date.now() + deadlineMs;
  const current = await inspectConfiguration(cwd, { stateRoot });
  if (current.provider !== 'mem0') return blocked(current.reason ?? 'not_mem0');
  if (bootstrapSessionId !== undefined) {
    const session = await resolveProject(cwd, bootstrapSessionId, { stateRoot });
    if (session.provider !== 'mem0') return blocked(session.reason ?? 'unbound');
    if (session.projectRoot !== current.projectRoot ||
        session.projectId !== current.projectId ||
        session.embeddingFingerprint !== current.embeddingFingerprint ||
        JSON.stringify(session.destination) !== JSON.stringify(current.destination)) {
      return blocked('session_changed');
    }
  }
  const trust = await readLocalTrust(current.stateDir);
  if (!sameTrustTuple(trustTuple(current), trust)) {
    return blocked('trust_changed');
  }
  let ownsStart = false;
  let spawnFailed = false;
  try {
    let status = await brokerEndpointStatus(root);
    if (status === 'unsafe') return blocked('unsafe_broker');
    if (status === 'live') return { kind: 'ready' };
    if (Date.now() >= deadline) return blocked('broker_unavailable');
    if ((status === 'missing' || status === 'orphan') && !starting.has(root)) {
      starting.add(root);
      ownsStart = true;
      try {
        const script = fileURLToPath(new URL('./broker.mjs', import.meta.url));
        const child = spawnBroker(process.execPath, [script, root, cwd],
          { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME,
            ...(process.env.CBS_MEMORIA_EMBEDDING_DEVICE !== undefined ? {
              CBS_MEMORIA_EMBEDDING_DEVICE: process.env.CBS_MEMORIA_EMBEDDING_DEVICE,
            } : {}), ...(process.env.CBS_MEMORIA_CA_FILE ? {
              CBS_MEMORIA_CA_FILE: process.env.CBS_MEMORIA_CA_FILE,
            } : {}) } });
        child.once?.('error', () => { spawnFailed = true; });
        child.unref();
      } catch { return blocked('broker_unavailable'); }
    }
    while (Date.now() < deadline) {
      if (spawnFailed) return blocked('broker_unavailable');
      status = await brokerEndpointStatus(root);
      if (status === 'live') return { kind: 'ready' };
      if (status === 'unsafe') return blocked('unsafe_broker');
      await pause(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    return blocked('broker_unavailable');
  } finally {
    if (ownsStart) starting.delete(root);
  }
}
