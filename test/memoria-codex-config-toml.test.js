import test from 'node:test';
import assert from 'node:assert/strict';
import { codexHookOverride, codexTomlString } from '../base/memoria/codex-config-toml.mjs';

const group = command => [{ hooks: [{ type: 'command', command, timeout: 10 }] }];

test('Codex session hook override is a TOML sequence with escaped Windows paths', () => {
  const command = String.raw`"C:\Users\Ana\Node\node.exe" "C:\memória\capture-hook.mjs" codex SessionStart`;
  assert.equal(codexHookOverride('SessionStart', group(command)),
    String.raw`hooks.SessionStart=[{hooks=[{type="command",command="\"C:\\Users\\Ana\\Node\\node.exe\" \"C:\\memória\\capture-hook.mjs\" codex SessionStart",timeout=10}]}]`);
});

test('Codex carries the verified Bash-only skill trigger into linked sessions', () => {
  const command = '"/usr/bin/node" "/pkg/skill-hook-cli.mjs" codex';
  assert.equal(codexHookOverride('PreToolUse', [{ matcher: 'Bash',
    hooks: [{ type: 'command', command, timeout: 10 }] }]),
  `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${JSON.stringify(command)},timeout=10}]}]`);
});

test('Codex session hook override accepts only the verified CBS group shape', () => {
  for (const [event, groups] of [
    ['PreToolUse', group('echo fixture')],
    ['SessionStart.extra', group('echo fixture')],
    ['SessionStart', []],
    ['SessionStart', [...group('echo fixture'), ...group('echo fixture')]],
    ['SessionStart', [{ hooks: [{ type: 'command', command: 'echo fixture', timeout: 10 }], matcher: '*' }]],
    ['SessionStart', [{ hooks: [{ type: 'prompt', command: 'echo fixture', timeout: 10 }] }]],
    ['SessionStart', [{ hooks: [{ type: 'command', command: 'echo fixture', timeout: 5 }] }]],
    ['SessionStart', group('echo\nfixture')],
    ['SessionStart', group('echo\u007ffixture')],
    ['SessionStart', group('echo\ud800fixture')],
    ['SessionStart', group('')],
  ]) assert.throws(() => codexHookOverride(event, groups), { message: 'invalid_codex_hook' });
});

test('Codex MCP path scalar is a TOML basic string', () => {
  assert.equal(codexTomlString(String.raw`C:\Users\Ana\Node\node.exe`),
    String.raw`"C:\\Users\\Ana\\Node\\node.exe"`);
});
