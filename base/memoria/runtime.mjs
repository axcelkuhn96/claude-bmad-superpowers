import { createReadStream, constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hashWindowsFile, holdWindowsHash, readWindowsBinary } from './windows-security.mjs';

export const RUNTIME_PINS = Object.freeze({
  python: '>=3.11', sdk: 'mem0ai==2.2.1', qdrant: 'qdrant-client==1.19.1',
  onnx: 'onnxruntime==1.30.0', onnxCuda: 'onnxruntime-gpu[cuda,cudnn]==1.30.0',
  onnxDirectml: 'onnxruntime-directml==1.24.4',
  tokenizers: 'tokenizers==0.23.2', numpy: 'numpy==2.5.3',
  httpx: 'httpx==0.28.1', httpcore: 'httpcore==1.0.9',
  modelSha256: [
    'ca456c06b3a9505ddfd9131408916d',
    'd79290368331e7d76bb621f1cba6bc8665',
  ].join(''),
  tokenizerSha256: [
    '0b44a9d7b51c3c62626640cda0e2c',
    '2f70fdacdc25bbbd68038369d14ebdf4c39',
  ].join(''),
  dimensions: 384, pooling: 'masked-mean-l2', queryPrefix: 'query: ', passagePrefix: 'passage: ',
});

export function runtimePython(stateDir, platform = process.platform) {
  return path.join(stateDir, 'runtime', ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
}

export async function openArtifactIdentity(paths) {
  if (process.platform === 'win32') {
    const held = [];
    try {
      for (const file of paths) {
        const identity = await hashWindowsFile(file);
        const release = await holdWindowsHash(file, identity.fileId, identity.sha256);
        held.push({ file, identity, release });
      }
      return { kind: 'opened', unchanged: async () => {
        try {
          for (const { file, identity } of held) {
            const current = await readWindowsBinary(file, { length: 0 });
            if (current.fileId !== identity.fileId || current.size !== identity.size) return false;
          }
          return true;
        } catch { return false; }
      }, close: async () => { for (const { release } of held.reverse()) release(); } };
    } catch {
      for (const { release } of held.reverse()) release();
      return { kind: 'blocked', reason: 'artifact_changed' };
    }
  }
  const handles = [];
  const baseline = [];
  const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
  async function same(file, handle, expected) {
    const [name, opened] = await Promise.all([fs.lstat(file, { bigint: true }), handle.stat({ bigint: true })]);
    return name.isFile() && opened.isFile() && fields.every(field =>
      name[field] === expected[field] && opened[field] === expected[field]);
  }
  try {
    for (const file of paths) {
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.push(handle);
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || !await same(file, handle, stat)) throw new Error('artifact_changed');
      baseline.push(stat);
    }
    return { kind: 'opened', unchanged: async () => {
      try { return (await Promise.all(paths.map((file, index) => same(file, handles[index], baseline[index]))))
        .every(Boolean); }
      catch { return false; }
    }, close: async () => Promise.all(handles.map(handle => handle.close())) };
  } catch {
    await Promise.all(handles.map(handle => handle.close()));
    return { kind: 'blocked', reason: 'artifact_changed' };
  }
}

async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export async function verifyRuntimeArtifacts(model, tokenizer) {
  try {
    const modelHash = process.platform === 'win32' ? (await hashWindowsFile(model)).sha256 : await sha256(model);
    const tokenizerHash = process.platform === 'win32'
      ? (await hashWindowsFile(tokenizer)).sha256 : await sha256(tokenizer);
    if (modelHash !== RUNTIME_PINS.modelSha256 || tokenizerHash !== RUNTIME_PINS.tokenizerSha256) {
      return { kind: 'blocked', reason: 'artifact_mismatch' };
    }
  } catch { return { kind: 'blocked', reason: 'missing_artifact' }; }
  return { kind: 'verified', fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` };
}

export function runtimeEnvironment(stateDir, sourceEnv = process.env) {
  const env = { ...sourceEnv, MEM0_TELEMETRY: '0', MEM0_DIR: path.join(stateDir, 'mem0'),
    CBS_MEMORIA_HISTORY: path.join(stateDir, 'mem0', 'history.db'),
    CBS_MEMORIA_EMBEDDING_DEVICE: sourceEnv.CBS_MEMORIA_EMBEDDING_DEVICE ?? 'auto' };
  for (const key of Object.keys(env)) if (/^OPENAI_(API_KEY|BASE_URL|ORGANIZATION|PROJECT)$/.test(key)) delete env[key];
  return env;
}
