import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { authorizeCurrentDestination } from './setup.mjs';
import { resolveProject } from './provider.mjs';
import { runtimeEnvironment, verifyRuntimeArtifacts } from './runtime.mjs';
import { createLedger, externalIdFor, reconcileStore, withProjectLock } from './ledger.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'mem0_adapter.py');

async function runPython(python, program, request, env) {
  return new Promise((resolve) => {
    const child = spawn(python, [program], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 2 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.on('error', () => { clearTimeout(timer); resolve(blocked('python_unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { resolve(blocked('bridge_failed')); return; }
      try { resolve(JSON.parse(output)); } catch { resolve(blocked('bridge_invalid_response')); }
    });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') resolve(blocked('bridge_input_failed'));
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

export async function runBridgeOperation(cwd, sessionId, operation, readSecret, options = {}) {
  const resolution = await (options.resolve ?? resolveProject)(cwd, sessionId, options);
  if (resolution.provider !== 'mem0' || operation.projectId !== resolution.projectId) {
    return blocked('project_mismatch');
  }
  const state = resolution.stateDir;
  const model = path.join(state, 'artifacts', 'model.onnx');
  const tokenizer = path.join(state, 'artifacts', 'tokenizer.json');
  if (!options.run) {
    const artifacts = await verifyRuntimeArtifacts(model, tokenizer);
    if (artifacts.kind !== 'verified') return artifacts;
  }
  const auth = await (options.authorize ?? authorizeCurrentDestination)(cwd, sessionId, readSecret, options);
  if (auth.kind !== 'authorized') return auth;
  const request = { ...operation, collection: resolution.destination.collection, connection: auth.connection };
  const env = { ...runtimeEnvironment(state), CBS_MEMORIA_STATE: state,
    CBS_MEMORIA_MODEL: model, CBS_MEMORIA_TOKENIZER: tokenizer, CBS_MEMORIA_API_KEY: auth.key,
    OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' };
  return (options.run ?? runPython)(path.join(state, 'runtime', 'bin', 'python'), script, request, env);
}

export async function storeMemory(cwd, sessionId, operation, readSecret, options = {}) {
  if (!operation?.externalId || !operation?.projectId || !operation?.sessionId ||
      !operation?.text || !operation?.metadata?.source || !operation.metadata.actor ||
      !operation.metadata.origin || !operation.metadata.scope || !operation.metadata.evidence_at ||
      operation.approval?.kind !== 'approved' || !options.writerId ||
      (operation.metadata.scope === 'personal' && !operation.metadata.owner_id)) return blocked('invalid_store');
  try {
    if (externalIdFor(operation.sourceIdentity) !== operation.externalId ||
        operation.sourceIdentity.projectId !== operation.projectId ||
        operation.sourceIdentity.sessionId !== operation.sessionId) return blocked('source_identity_mismatch');
  } catch { return blocked('invalid_source_identity'); }
  const resolution = await resolveProject(cwd, sessionId, options);
  if (resolution.provider !== 'mem0' || resolution.projectId !== operation.projectId) return blocked('project_mismatch');
  const bridge = request => runBridgeOperation(cwd, sessionId, request, readSecret, options);
  const response = await withProjectLock(resolution.stateDir, () => reconcileStore(operation, {
    ledger: createLedger(resolution.stateDir, options.writerId),
    findRemote: async externalId => {
      const result = await bridge({ op: 'find', projectId: operation.projectId, externalId });
      if (result.kind !== 'items') throw Object.assign(new Error('remote_read_failed'), { code: result.reason ?? 'remote_read_failed' });
      return result.items;
    },
    addViaSdk: async () => {
      const result = await bridge({ op: 'add', ...operation });
      if (result.kind !== 'pending') throw Object.assign(new Error('remote_add_failed'), { code: result.reason ?? 'remote_add_failed' });
    },
    readRemote: async sdkId => {
      const result = await bridge({ op: 'read', projectId: operation.projectId, sdkId });
      if (result.kind !== 'item') throw Object.assign(new Error('remote_read_failed'), { code: result.reason ?? 'remote_read_failed' });
      return result.item;
    },
    activateViaSdk: async sdkId => {
      const result = await bridge({ op: 'activate', projectId: operation.projectId,
        externalId: operation.externalId, sdkId });
      if (result.kind !== 'item') throw Object.assign(new Error('remote_activate_failed'), { code: result.reason ?? 'remote_activate_failed' });
    },
    ackLocal: options.ackLocal,
  }));
  return response;
}

export async function searchProject({ cwd, sessionId, query, projectId }, readSecret, options = {}) {
  if (typeof query !== 'string' || !query.trim()) return blocked('invalid_query');
  const resolution = await (options.resolve ?? resolveProject)(cwd, sessionId, options);
  if (resolution.provider !== 'mem0' || (projectId && projectId !== resolution.projectId)) return blocked('project_mismatch');
  return runBridgeOperation(cwd, sessionId, { op: 'search', projectId: resolution.projectId, query,
    ownerId: options.ownerId }, readSecret, options);
}
