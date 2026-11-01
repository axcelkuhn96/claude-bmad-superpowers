import test from 'node:test';
import assert from 'node:assert/strict';
import { recallBudgetMs } from '../base/memoria/hook-recall.mjs';
import { main } from '../base/memoria/cli.mjs';

test('recall budget keeps the default unless a bounded opt-in is given', t => {
  const saved = process.env.CBS_MEMORIA_RECALL_BUDGET_MS;
  t.after(() => { if (saved !== undefined) process.env.CBS_MEMORIA_RECALL_BUDGET_MS = saved; });
  delete process.env.CBS_MEMORIA_RECALL_BUDGET_MS;
  assert.equal(recallBudgetMs(undefined), 825);
  process.env.CBS_MEMORIA_RECALL_BUDGET_MS = '3000';
  assert.equal(recallBudgetMs(undefined), 3000);
  delete process.env.CBS_MEMORIA_RECALL_BUDGET_MS;
  for (const invalid of ['', 'abc', '100', '824', '5001', '99999', '-1', '3000ms']) {
    assert.equal(recallBudgetMs(invalid), 825, invalid);
  }
  for (const valid of [825, 3000, 5000]) assert.equal(recallBudgetMs(String(valid)), valid);
});

test('enroll requires every argument before touching state', async () => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await main(['enroll']), 2);
    assert.equal(await main(['enroll', '--tool', 'python']), 2);
    assert.equal(await main(['enroll', '--tool', 'python', '--executable', 'x.exe']), 2);
  } finally { process.stderr.write = write; }
});

test('enroll refuses an invalid tool, digest or platform without enrolling', async () => {
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = chunk => { lines.push(String(chunk)); return true; };
  let code;
  try {
    code = await main(['enroll', '--tool', 'bash', '--executable', 'C:\\x.exe', '--sha256', 'zz']);
  } finally { process.stdout.write = write; }
  assert.equal(code, 1);
  assert.match(lines.join(''), process.platform === 'win32'
    ? /^blocked: windows_enrollment_args/ : /^blocked: windows_only/);
});
