import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLedger, reconcileStore, withProjectLock } from '../base/memoria/ledger.mjs';

const [root, externalId, stage] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'meta.json'), 'utf8'));
const key = fs.readFileSync(path.join(root, 'key'), 'utf8').trim();
const state = '/tmp/cbs-mem0-runtime-m002-validacao-20261001/state';
const projectId = 'crash-project';
const operation = { externalId, projectId, sessionId: 'crash-session', text: 'Review release before publishing',
  metadata: { source: 'synthetic-crash', actor: 'owner', origin: 'user_direct', scope: 'project',
    evidence_at: '2026-09-30T12:00:00Z' } };
const connection = { url: `http://localhost:${fixture.port}/`, hostname: 'localhost', address: '127.0.0.1',
  port: fixture.port, protocol: 'http:', servername: 'localhost' };
const script = path.resolve('base/memoria/python/mem0_adapter.py');
const ledger = createLedger(path.join(root, 'ledger-state'), 'writer-a');
const ackFile = path.join(root, `${externalId}.ack`);
const addFile = path.join(root, `${externalId}.add`);

function crash(at) {
  if (stage === at) { fs.writeSync(1, `KILL:${at}\n`); process.kill(process.pid, 'SIGKILL'); }
}

function python(request) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CBS_MEMORIA_API_KEY: key, CBS_MEMORIA_STATE: state,
      CBS_MEMORIA_MODEL: path.join(state, 'artifacts/model.onnx'),
      CBS_MEMORIA_TOKENIZER: path.join(state, 'artifacts/tokenizer.json'), MEM0_TELEMETRY: '0' };
    const child = spawn(path.join(state, 'runtime/bin/python'), [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`adapter_exit:${code}:${error.slice(-500)}`));
      try {
        const result = JSON.parse(output);
        if (result.kind === 'blocked') return reject(new Error(`adapter_blocked:${result.reason}`));
        resolve(result);
      } catch (problem) { reject(problem); }
    });
    child.stdin.end(JSON.stringify({ ...request, collection: fixture.collection, connection }) + '\n');
  });
}

crash('before_enqueue');
if (stage === 'after_enqueue') {
  await ledger.begin(operation);
  crash('after_enqueue');
}
const result = await withProjectLock(path.join(root, 'ledger-state'), () => reconcileStore(operation, {
  ledger,
  findRemote: async () => {
    const rows = (await python({ op: 'find', projectId, externalId })).items;
    if (rows.length === 0) crash('before_remote_store');
    return rows;
  },
  addViaSdk: async () => {
    fs.appendFileSync(addFile, 'add\n');
    await python({ op: 'add', ...operation });
    crash('after_remote_add');
  },
  readRemote: async sdkId => (await python({ op: 'read', projectId, sdkId })).item,
  activateViaSdk: async sdkId => {
    await python({ op: 'activate', projectId, externalId, sdkId });
    crash('after_active_before_ack');
  },
  ackLocal: async (id, proof) => {
    if (id !== externalId || proof.status !== 'active' || proof.sdkId !== proof.qdrantId) throw new Error('invalid_ack_proof');
    const fd = fs.openSync(ackFile, 'w', 0o600);
    try { fs.writeSync(fd, JSON.stringify({ sdkId: proof.sdkId, status: proof.status })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    crash('after_ack');
    return { kind: 'acked', operationId: id };
  },
}));
fs.writeSync(1, JSON.stringify(result) + '\n');
