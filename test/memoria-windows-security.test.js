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

test('Windows file transport rejects missing byte and identity versions', () => {
  const good = { ok: true, code: 'safe', ownerMatches: true, localNtfs: true,
    noReparse: true, daclSafe: true, currentSid: 'S-1-5-21-1', text: 'fixture',
    sha256: 'a'.repeat(64), fileId: '12345678:1234567890abcdef' };
  assert.equal(parseWindowsSecurityResult(JSON.stringify(good), { version: true }).ok, true);
  for (const bad of [{ ...good, sha256: undefined }, { ...good, fileId: undefined },
    { ...good, text: undefined }, { ...good, sha256: 'a'.repeat(63) },
    { ...good, fileId: '12345678:changed' }]) {
    assert.equal(parseWindowsSecurityResult(JSON.stringify(bad), { version: true }).ok, false);
  }
});

test('Windows existing-file write refuses before touching the destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-windows-replace-'));
  const file = path.join(root, 'config.json');
  try {
    await fs.writeFile(file, 'external edit');
    const result = await security.writeWindowsPrivateFile(file, 'ours',
      { replace: true, expectedText: 'previous observation' });
    assert.deepEqual(result, { ok: false, code: 'unsupported_windows_replace' });
    assert.equal(await fs.readFile(file, 'utf8'), 'external edit');
    assert.deepEqual(await fs.readdir(root), ['config.json']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows deletion requires an exact byte and file identity token', async () => {
  const result = await security.removeWindowsPrivateFile('C:\\fixture\\config.json', 'decoded text');
  assert.deepEqual(result, { ok: false, code: 'changed' });
});

test('Windows byte reader rejects BOM and distinct invalid UTF-8 byte sequences', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-windows-bytes-'));
  try {
    await fs.writeFile(path.join(root, 'bom'), Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
    await fs.writeFile(path.join(root, 'invalid-a'), Buffer.from([0xff]));
    await fs.writeFile(path.join(root, 'invalid-b'), Buffer.from([0xfe]));
    const script = String.raw`
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CBS_WINDOWS_PROGRAM))
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'security program parse error' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ExactVersion' }, $true)
. ([scriptblock]::Create($definition.Extent.Text))
$results = foreach ($name in @('bom', 'invalid-a', 'invalid-b')) {
  $stream = [System.IO.File]::OpenRead([System.IO.Path]::Combine($env:CBS_WINDOWS_BYTES, $name))
  try { try { [void](ExactVersion $stream); 'accepted' } catch { $_.Exception.Message } }
  finally { $stream.Dispose() }
}
ConvertTo-Json -InputObject @($results) -Compress
`;
    const { stdout } = await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, CBS_WINDOWS_PROGRAM: Buffer.from(security.WINDOWS_SECURITY_PROGRAM).toString('base64'),
        CBS_WINDOWS_BYTES: root } });
    assert.deepEqual(JSON.parse(stdout.trim()), ['invalid_text', 'invalid_text', 'invalid_text']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Windows lock fixture serializes missing prerequisite and executed failure distinctly', async () => {
  const fixture = new URL('./memoria-windows-validation.ps1', import.meta.url);
  const script = String.raw`
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:CBS_WINDOWS_FIXTURE, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'fixture parse error' }
$names = @('Record', 'Record-LockOutcome')
$defs = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names }, $true)
foreach ($definition in $defs) { . ([scriptblock]::Create($definition.Extent.Text)) }
$report = @{ controls = @{} }
Record-LockOutcome $false $false @{ reason = 'precondition missing' }
$precondition = $report.controls['own_child_lock_crash_fixture']
Record-LockOutcome $true $false @{ reason = 'reacquire failed' }
$executed = $report.controls['own_child_lock_crash_fixture']
@{ precondition = $precondition; executed = $executed } | ConvertTo-Json -Compress -Depth 5
`;
  const { stdout } = await run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, CBS_WINDOWS_FIXTURE: new URL(fixture).pathname } });
  const result = JSON.parse(stdout.trim());
  assert.deepEqual([result.precondition.status, result.precondition.executed],
    ['missing_prerequisite', false]);
  assert.deepEqual([result.executed.status, result.executed.executed], ['failed', true]);
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
