import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as security from '../base/memoria/windows-security.mjs';
const { windowsPathKey, parseWindowsSecurityResult } = security;
const run = promisify(execFile);

test('Windows identity folds drive and case without merging different worktrees', () => {
  assert.equal(windowsPathKey('C:\\Users\\Me\\Repo'), windowsPathKey('c:\\users\\me\\repo'));
  assert.notEqual(windowsPathKey('C:\\Users\\Me\\Repo'), windowsPathKey('C:\\Users\\Me\\Other'));
});

test('Windows identity rejects ambiguous paths before filesystem operations', () => {
  for (const value of ['\\\\server\\share\\repo', '\\\\?\\C:\\repo', '\\\\.\\C:\\repo',
    'C:relative', 'C:\\repo\\..\\other', 'C:\\repo\\trailing. ', 'C:\\repo:stream', '/tmp/repo']) {
    assert.throws(() => windowsPathKey(value), /unsafe_windows_path/);
  }
});

test('Windows security transport accepts only complete safe verdicts', () => {
  const good = { ok: true, code: 'safe', ownerMatches: true, localNtfs: true,
    noReparse: true, daclSafe: true, currentSid: 'S-1-5-21-1' };
  assert.equal(parseWindowsSecurityResult(JSON.stringify(good)).ok, true);
  for (const bad of [
    { ...good, daclSafe: false }, { ...good, localNtfs: false },
    { ...good, ownerMatches: false }, { ...good, noReparse: false },
    { ...good, currentSid: 'arbitrary' }, { ...good, code: 'unknown' },
  ]) assert.equal(parseWindowsSecurityResult(JSON.stringify(bad)).ok, false);
  assert.equal(parseWindowsSecurityResult('not-json').ok, false);
});

test('Windows Git exclusion uses Git directory separators', () => {
  assert.equal(security.windowsGitPattern('C:\\fixture', 'C:\\fixture\\.claude\\settings.local.json'),
    '/.claude/settings.local.json');
  assert.throws(() => security.windowsGitPattern('C:\\fixture', 'C:\\other\\file'), /unsafe_windows_path/);
});

test('Git honors the generated Windows exclusion with no global ignore', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-windows-ignore-'));
  try {
    await run('git', ['init', '-q', root]);
    await fs.mkdir(path.join(root, '.claude'));
    await fs.writeFile(path.join(root, '.claude', 'settings.local.json'), '{}');
    await fs.writeFile(path.join(root, '.git', 'info', 'exclude'),
      security.windowsGitPattern('C:\\fixture', 'C:\\fixture\\.claude\\settings.local.json') + '\n');
    await run('git', ['-c', 'core.excludesfile=' + path.join(root, 'absent-global-ignore'),
      '-C', root, 'check-ignore', '-q', '--', '.claude/settings.local.json']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Win32 N-API artifact has the source-pinned integrity identity', async () => {
  const bytes = await fs.readFile(new URL('../base/memoria/bin/windows-native-x64.node', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), security.WINDOWS_NATIVE_SHA256);
  assert.equal(bytes.readUInt16LE(0), 0x5a4d);
});

test('Codex plugin probe requires an exact installed local plugin row', () => {
  assert.equal(security.windowsCodexPluginInstalled('claude-mem@claude-mem-local installed'), true);
  for (const output of ['evil-claude-mem@claude-mem-local installed',
    'claude-mem@claude-mem-local not-installed',
    'claude-mem@claude-mem-local installed workspace.managed']) {
    assert.equal(security.windowsCodexPluginInstalled(output), false);
  }
});
