import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsPathKey, parseWindowsSecurityResult } from '../base/memoria/windows-security.mjs';

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
