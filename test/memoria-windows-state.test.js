import test from 'node:test';
import assert from 'node:assert/strict';
import { completedWindowsReceipts } from '../base/memoria/windows-state.mjs';

test('completed Windows journal keeps one current proof and preserves ambiguous records', () => {
  const target = 'c:\\fixture\\state.json';
  const fileId = '12345678:1234567890abcdef';
  const prefix = 'a'.repeat(64);
  const old = { target, fileId, transaction: '00000000-0000-4000-8000-000000000001', sha256: 'b'.repeat(64) };
  const current = { ...old, transaction: '00000000-0000-4000-8000-000000000002', sha256: 'c'.repeat(64) };
  const entries = [old, current].map(proof => ({
    name: `${prefix}-${proof.transaction}.commit.json`, proof,
  }));
  assert.deepEqual(completedWindowsReceipts({ target, fileId, sha256: current.sha256, prefix }, entries),
    [entries[0].name]);
  assert.deepEqual(completedWindowsReceipts({ target, fileId, sha256: current.sha256, prefix },
    [...entries, { name: `${prefix}-00000000-0000-4000-8000-000000000003.commit.json`,
      proof: { ...old, target: 'c:\\foreign\\state.json' } }]), []);
  assert.deepEqual(completedWindowsReceipts({ target, fileId, sha256: 'd'.repeat(64), prefix }, entries), []);
  assert.deepEqual(completedWindowsReceipts({ target, fileId, sha256: current.sha256, prefix },
    [...entries, { name: `${prefix}-00000000-0000-4000-8000-000000000004.commit.json`,
      proof: { ...old, transaction: '00000000-0000-4000-8000-000000000004', extra: true } }]), []);
});
