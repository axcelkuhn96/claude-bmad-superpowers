import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const schema = JSON.stringify({ type: 'object', additionalProperties: false,
  required: ['candidates', 'no_facts'], properties: {
    no_facts: { type: 'boolean' }, candidates: { type: 'array', maxItems: 5, items: {
      type: 'object', additionalProperties: false,
      required: ['candidate_key', 'source_message_id', 'text', 'type', 'actor', 'speaker_role',
        'origin', 'evidence_at', 'scope'], properties: {
        candidate_key: { type: 'string' }, source_message_id: { type: 'string' },
        logical_key: { type: 'string' }, text: { type: 'string' }, type: { type: 'string' },
        actor: { type: 'string' }, speaker_role: { type: 'string' }, origin: { type: 'string' },
        evidence_at: { type: 'string' }, scope: { type: 'string' }, owner_id: { type: 'string' },
        condition: { type: 'string' }, valid_from: { type: 'string' }, valid_to: { type: 'string' },
        supersedes_id: { type: 'string' },
      },
    } },
  },
});

export async function runSonnetExtraction(prompt, policy = {}) {
  if (policy.route !== 'sonnet' || policy.account !== 'claude2' ||
      typeof prompt !== 'string' || Buffer.byteLength(prompt) > 1024 * 1024) {
    return { kind: 'error', reason: 'invalid_cli_request' };
  }
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-extract-'));
  await fs.chmod(cwd, 0o700);
  try {
    return await new Promise(resolve => {
      const args = ['--safe-mode', '--tools', '', '--print', '--output-format', 'json',
        '--model', 'sonnet', '--no-session-persistence', '--permission-mode', 'dontAsk',
        '--max-budget-usd', '0.10', '--json-schema', schema];
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd,
        CLAUDE_CONFIG_DIR: '/home/axcel/.claude-conta2', LANG: 'C.UTF-8' };
      const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
        if (result.subtype !== 'success' || result.is_error || !result.structured_output ||
            !Array.isArray(result.structured_output.candidates) ||
            typeof result.structured_output.no_facts !== 'boolean') {
          return finish({ kind: 'error', reason: 'cli_invalid_schema' });
        }
        const model = Object.values(result.modelUsage ?? {})[0]?.canonicalModel;
        if (typeof model !== 'string' || !/^claude-sonnet-[a-z0-9-]+$/.test(model)) {
          return finish({ kind: 'error', reason: 'cli_model_mismatch' });
        }
        return finish({ kind: 'success', ...result.structured_output, model,
          usage: { inputTokens: result.usage?.input_tokens ?? null,
            outputTokens: result.usage?.output_tokens ?? null,
            costUsd: result.total_cost_usd ?? null } });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}
