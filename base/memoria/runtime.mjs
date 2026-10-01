import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const RUNTIME_PINS = Object.freeze({
  python: '>=3.11', sdk: 'mem0ai==2.2.1', qdrant: 'qdrant-client==1.19.1',
  onnx: 'onnxruntime==1.30.0', tokenizers: 'tokenizers==0.23.2', numpy: 'numpy==2.5.3',
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

async function sha256(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

export async function verifyRuntimeArtifacts(model, tokenizer) {
  try {
    if (await sha256(model) !== RUNTIME_PINS.modelSha256 ||
        await sha256(tokenizer) !== RUNTIME_PINS.tokenizerSha256) {
      return { kind: 'blocked', reason: 'artifact_mismatch' };
    }
  } catch { return { kind: 'blocked', reason: 'missing_artifact' }; }
  return { kind: 'verified', fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` };
}

export function runtimeEnvironment(stateDir, sourceEnv = process.env) {
  const env = { ...sourceEnv, MEM0_TELEMETRY: '0', MEM0_DIR: path.join(stateDir, 'mem0'),
    CBS_MEMORIA_HISTORY: path.join(stateDir, 'mem0', 'history.db') };
  for (const key of Object.keys(env)) if (/^OPENAI_(API_KEY|BASE_URL|ORGANIZATION|PROJECT)$/.test(key)) delete env[key];
  return env;
}
