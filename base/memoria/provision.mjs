#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectConfiguration } from './provider.mjs';
import { readLocalTrust, sameTrustTuple, trustTuple, authorizeDestination } from './trust.mjs';
import { runtimeEnvironment, runtimePython, verifyRuntimeArtifacts } from './runtime.mjs';
import { identifyProject } from './project-id.mjs';
import { pinDestination } from './activation.mjs';
import { readQdrantSecret } from './qdrant-key.mjs';
import { resolveEnrolledWindowsTool } from './windows-enrollment.mjs';
import { ensureWindowsPrivateDirectory, windowsPathKey } from './windows-security.mjs';

const runFile = promisify(execFile);
const blocked = (reason) => ({ kind: 'blocked', reason });

async function runIndexPython(request, secret, stateDir) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'mem0_adapter.py');
  const child = spawn(runtimePython(stateDir), [script], { stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...runtimeEnvironment(stateDir), CBS_MEMORIA_STATE: stateDir,
      CBS_MEMORIA_API_KEY: secret } });
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish(blocked('deadline')); }, 120000);
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (output.length > 65536) { child.kill(); finish(blocked('response_oversized')); }
    });
    child.once('error', () => finish(blocked('worker_unavailable')));
    child.stdin.on('error', () => {});
    child.once('close', code => {
      if (code !== 0) return finish(blocked('worker_failed'));
      try { finish(JSON.parse(output.trim())); }
      catch { finish(blocked('worker_protocol')); }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

export async function indexTextProject(cwd, options = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return blocked('invalid_project');
  cwd = path.resolve(cwd);
  const inspect = options.inspect ?? inspectConfiguration;
  const resolution = await inspect(cwd, options);
  if (resolution.provider !== 'mem0') return blocked(resolution.reason ?? 'not_mem0');
  const scope = await (options.identify ?? identifyProject)(cwd);
  const sameRoot = process.platform === 'win32' ? scope.activeRoot === windowsPathKey(cwd)
    : scope.activeRoot === cwd;
  if (scope.kind !== 'git' || !sameRoot ||
      scope.projectRoot !== resolution.projectRoot) return blocked('unsupported_git');
  const expected = trustTuple(resolution);
  if (!sameTrustTuple(expected, await (options.trust ?? readLocalTrust)(resolution.stateDir))) {
    return blocked('trust_changed');
  }
  const destination = resolution.destination;
  const pin = await (options.pin ?? pinDestination)(destination.url, { address: destination.address,
    allowPublic: destination.allowPublic });
  if (pin.kind !== 'pinned') return blocked(pin.reason ?? 'destination_unavailable');
  const current = await inspect(cwd, options);
  if (current.provider !== 'mem0' || current.projectId !== resolution.projectId ||
      current.embeddingFingerprint !== resolution.embeddingFingerprint ||
      !sameTrustTuple(expected, trustTuple(current))) return blocked('config_changed');
  const auth = authorizeDestination(current,
    await (options.trust ?? readLocalTrust)(current.stateDir), options.readSecret ?? readQdrantSecret);
  if (auth.kind !== 'authorized') return auth;
  const request = { op: 'index_text', projectId: current.projectId,
    collection: current.destination.collection, connection: pin.connection };
  try { return await (options.run ?? ((value, key) =>
    runIndexPython(value, key, current.stateDir)))(request, auth.key); }
  catch { return blocked('worker_failed'); }
}

export async function provisionRuntime(cwd, model, tokenizer, options = {}) {
  if (process.platform !== 'win32' && !process.getuid) return blocked('native_windows_unproved');
  const resolution = await inspectConfiguration(cwd, options);
  if (resolution.provider !== 'mem0') return blocked(resolution.reason);
  const localTrust = await readLocalTrust(resolution.stateDir);
  const expected = trustTuple(resolution);
  if (!sameTrustTuple(expected, localTrust)) {
    return blocked('trust_changed');
  }
  const verified = await verifyRuntimeArtifacts(model, tokenizer);
  if (verified.kind !== 'verified') return verified;
  const current = await inspectConfiguration(cwd, options);
  if (current.provider !== 'mem0' || !sameTrustTuple(expected, trustTuple(current))) return blocked('config_changed');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'setup_runtime.py');
  const args = [script, '--state', resolution.stateDir, '--model', model, '--tokenizer', tokenizer];
  let tool;
  if (process.platform === 'win32') {
    try {
      if (!(await ensureWindowsPrivateDirectory(resolution.stateDir)).ok) return blocked('runtime_state_unsafe');
      tool = await resolveEnrolledWindowsTool({ stateRoot: options.stateRoot, name: 'python',
        projectRoot: resolution.projectRoot,
        productRoot: path.resolve(path.dirname(script), '..', '..', '..') });
    } catch { return blocked('python_not_enrolled'); }
  }
  const runPython = options.runPython ?? ((a, env) => runFile(tool?.executable ?? options.python ?? 'python3', a,
    { env, timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024, windowsHide: true }));
  try { await runPython(args, runtimeEnvironment(resolution.stateDir)); }
  catch { return blocked('runtime_setup_failed'); }
  finally { tool?.release(); }
  return { kind: 'provisioned', stateDir: resolution.stateDir };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const cwd = value('--project');
  const model = value('--model');
  const tokenizer = value('--tokenizer');
  if (!cwd || !model || !tokenizer || [cwd, model, tokenizer].some((x) => x.startsWith('--'))) {
    process.stderr.write('Uso: node base/memoria/provision.mjs --project /git --model model.onnx --tokenizer tokenizer.json\n');
    process.exitCode = 2;
  } else {
    const result = await provisionRuntime(cwd, model, tokenizer);
    process.stdout.write(`${result.kind}: ${result.reason ?? result.stateDir}\n`);
    process.exitCode = result.kind === 'provisioned' ? 0 : 1;
  }
}
