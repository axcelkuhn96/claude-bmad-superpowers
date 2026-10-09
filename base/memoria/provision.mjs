#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectConfiguration } from './provider.mjs';
import { readLocalTrust, trustTuple } from './trust.mjs';
import { runtimeEnvironment, verifyRuntimeArtifacts } from './runtime.mjs';
import { resolveEnrolledWindowsTool } from './windows-enrollment.mjs';
import { ensureWindowsPrivateDirectory } from './windows-security.mjs';

const runFile = promisify(execFile);
const blocked = (reason) => ({ kind: 'blocked', reason });

export async function provisionRuntime(cwd, model, tokenizer, options = {}) {
  if (process.platform !== 'win32' && !process.getuid) return blocked('native_windows_unproved');
  const resolution = await inspectConfiguration(cwd, options);
  if (resolution.provider !== 'mem0') return blocked(resolution.reason);
  const localTrust = await readLocalTrust(resolution.stateDir);
  const expected = trustTuple(resolution);
  if (!localTrust || Object.entries(expected).some(([key, value]) => localTrust[key] !== value)) {
    return blocked('trust_changed');
  }
  const verified = await verifyRuntimeArtifacts(model, tokenizer);
  if (verified.kind !== 'verified') return verified;
  const current = await inspectConfiguration(cwd, options);
  if (current.provider !== 'mem0' || Object.entries(expected).some(([key, value]) =>
    trustTuple(current)[key] !== value)) return blocked('config_changed');
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
