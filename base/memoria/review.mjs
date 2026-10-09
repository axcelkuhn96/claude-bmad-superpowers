#!/usr/bin/env node
import { inspectConfiguration, resolveProject } from './provider.mjs';
import { createOutbox } from './outbox.mjs';
import { reviewCandidateOnTerminal } from './candidates.mjs';
import { identifyProject } from './project-id.mjs';
import { readSessionCheckout } from './session-checkout.mjs';
import { inspectWindowsPath } from './windows-security.mjs';
import os from 'node:os';

const [cli, cwd, sessionId, operationId, candidateKey] = process.argv.slice(2);
if (!['claude', 'codex'].includes(cli) || !cwd || !sessionId || !operationId || !candidateKey ||
    !process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('Usage in owner terminal: node review.mjs <caller-cli> <caller-checkout> <current-native-session-id> <checkpoint-id> <candidate-key>\n');
  process.exitCode = 2;
} else {
  const options = { stateRoot: process.env.CBS_MEMORIA_STATE_ROOT };
  const current = await resolveProject(cwd, sessionId, options);
  const config = await inspectConfiguration(cwd, options);
  const scope = await identifyProject(cwd);
  const checkout = current.provider === 'mem0'
    ? await readSessionCheckout(current.stateDir, cli, sessionId)
    : { kind: 'blocked' };
  if (current.provider !== 'mem0' || config.provider !== 'mem0' || current.projectId !== config.projectId ||
      scope.kind !== 'git' || checkout.kind !== 'bound' || checkout.nativeRoot !== scope.activeRoot ||
      checkout.projectId !== current.projectId) {
    process.stderr.write('CBS Mem0: session unavailable\n');
    process.exitCode = 1;
  } else {
    const sid = process.platform === 'win32'
      ? (await inspectWindowsPath(current.stateDir, 'directory')).currentSid : null;
    if (process.platform === 'win32' && !/^S-\d+(?:-\d+){2,}$/.test(sid ?? '')) {
      process.stderr.write('CBS Mem0: reviewer unavailable\n');
      process.exitCode = 1;
    } else {
    const result = await reviewCandidateOnTerminal(operationId, candidateKey, {
      outbox: createOutbox(current.stateDir), cwd, sessionId,
      writerId: process.platform === 'win32' ? `sid:${sid}` : `uid:${process.getuid()}`,
      ...(sid ? { actor: `sid:${sid}:${os.userInfo().username}` } : {}),
      readSecret: name => process.env[name],
    });
    process.stdout.write(`${result.kind}: ${result.reason ?? result.operationId ?? ''}\n`);
    process.exitCode = ['acked', 'processed'].includes(result.kind) ? 0 : 1;
    }
  }
}
