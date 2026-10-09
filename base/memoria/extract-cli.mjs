import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { extractionSchema, validateExtractionOutput } from './extract-contract.mjs';
import { identifyProject } from './project-id.mjs';
import { ensureWindowsPrivateDirectory, inspectWindowsPath } from './windows-security.mjs';
import { resolveEnrolledWindowsTool } from './windows-enrollment.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const schema = JSON.stringify(extractionSchema);
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export async function runSonnetExtraction(prompt, policy = {}) {
  if (policy.route !== 'sonnet' ||
      typeof prompt !== 'string' || Buffer.byteLength(prompt) > 1024 * 1024) {
    return { kind: 'error', reason: 'invalid_cli_request' };
  }
  const configuredProfile = process.env.CLAUDE_CONFIG_DIR;
  if (!configuredProfile) return { kind: 'error', reason: 'cli_profile_unselected' };
  const scope = await identifyProject(process.cwd());
  if (scope.kind !== 'git') return { kind: 'error', reason: 'cli_project_unresolved' };
  let profile;
  try {
    if (!path.isAbsolute(configuredProfile)) throw new Error('relative profile');
    profile = await fs.realpath(configuredProfile);
    const metadata = process.platform === 'win32'
      ? await inspectWindowsPath(profile, 'directory') : await fs.stat(profile);
    if ((process.platform === 'win32' ? !metadata.ok :
      !metadata.isDirectory() || !process.getuid || metadata.uid !== process.getuid() ||
      (metadata.mode & 0o022)) || [scope.projectRoot, scope.activeRoot].some(root =>
      profile === root || profile.startsWith(root + path.sep))) {
      throw new Error('untrusted profile');
    }
  } catch { return { kind: 'error', reason: 'cli_profile_untrusted' }; }
  const windows = process.platform === 'win32';
  const stateRoot = policy.stateRoot ?? process.env.CBS_MEMORIA_STATE_ROOT;
  if (windows && !stateRoot) return { kind: 'error', reason: 'cli_state_unselected' };
  const cwd = windows ? path.join(stateRoot, 'extraction-temp', randomUUID()) :
    await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-extract-'));
  if (windows) {
    if (!(await ensureWindowsPrivateDirectory(cwd)).ok) return { kind: 'error', reason: 'cli_temp_untrusted' };
  } else await fs.chmod(cwd, 0o700);
  let tool;
  try {
    if (windows) {
      try { tool = await resolveEnrolledWindowsTool({ stateRoot, name: 'claude',
        projectRoot: scope.projectRoot, activeRoot: scope.activeRoot,
        productRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..') }); }
      catch { return { kind: 'error', reason: 'cli_not_enrolled' }; }
    }
    return await new Promise(resolve => {
      const args = ['--safe-mode', '--tools', '', '--print', '--output-format', 'json',
        '--model', 'sonnet', '--no-session-persistence', '--permission-mode', 'dontAsk',
        '--max-budget-usd', '0.10', '--json-schema', schema];
      const env = windows ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        USERPROFILE: cwd, CLAUDE_CONFIG_DIR: profile } :
        { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd,
          CLAUDE_CONFIG_DIR: profile, LANG: 'C.UTF-8' };
      const child = spawn(tool?.executable ?? 'claude', args,
        { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let output = '';
      let oversized = false;
      let timedOut = false;
      let settled = false;
      const finish = value => { if (!settled) { settled = true; resolve(value); } };
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
      }, 90000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.length > 2 * 1024 * 1024) { oversized = true; child.kill('SIGTERM'); }
      });
      child.stderr.resume();
      child.once('error', () => { clearTimeout(timer); finish({ kind: 'error', reason: 'cli_unavailable' }); });
      child.once('close', code => {
        clearTimeout(timer);
        if (timedOut) return finish({ kind: 'error', reason: 'cli_timeout' });
        if (oversized) return finish({ kind: 'error', reason: 'cli_output_too_large' });
        if (code !== 0) return finish({ kind: 'error', reason: 'cli_failed' });
        let result;
        try { result = JSON.parse(output); } catch { return finish({ kind: 'error', reason: 'cli_invalid_json' }); }
        if (!result || typeof result !== 'object' || Array.isArray(result) ||
            result.subtype !== 'success' || result.is_error ||
            !validateExtractionOutput(result.structured_output)) {
          return finish({ kind: 'error', reason: 'cli_invalid_schema' });
        }
        const model = Object.values(result.modelUsage ?? {})[0]?.canonicalModel;
        if (typeof model !== 'string' || !/^claude-sonnet-[a-z0-9-]+$/.test(model)) {
          return finish({ kind: 'error', reason: 'cli_model_mismatch' });
        }
        const inputUncachedTokens = tokenCount(result.usage?.input_tokens);
        const inputCacheReadTokens = tokenCount(result.usage?.cache_read_input_tokens);
        const inputCacheCreationTokens = tokenCount(result.usage?.cache_creation_input_tokens);
        const knownInput = [inputUncachedTokens, inputCacheReadTokens, inputCacheCreationTokens]
          .filter(value => value !== null);
        return finish({ kind: 'success', ...result.structured_output, model,
          usage: { inputTokens: knownInput.length ? knownInput.reduce((sum, value) => sum + value, 0) : null,
            inputUncachedTokens, inputCacheReadTokens, inputCacheCreationTokens,
            outputTokens: tokenCount(result.usage?.output_tokens),
            costUsd: result.total_cost_usd ?? null } });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  } finally {
    tool?.release();
    if (windows && !(await inspectWindowsPath(cwd, 'directory')).ok) {
      throw new Error('cli_temp_changed');
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
