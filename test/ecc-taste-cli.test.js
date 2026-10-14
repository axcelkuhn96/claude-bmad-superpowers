import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../bin/cli.js', import.meta.url).pathname;
const corpus = new URL('../base/memoria/evals/curation-v1.json', import.meta.url).pathname;

function run(home, args, cwd = home) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: home, CBS_MEMORIA_QDRANT_KEY: '',
      CBS_MEMORIA_EXTRACTOR: '' } });
}

test('offline memory evaluation accepts packaged corpus without project, broker or credentials', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-eval-cli-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const outputs = path.join(home, 'outputs.json');
  await fs.writeFile(outputs, JSON.stringify({ version: 1, results: [] }));
  const result = run(home, ['memoria', 'avaliar', '--outputs', outputs, '--split', 'holdout']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.coverage.selected, 3);
  assert.equal(report.coverage.submitted, 0);
  assert.equal(report.semantic.status, 'unmeasured');
  assert.equal(report.assessment_scope, 'supplied_extractor_candidates_not_confirmed_Qdrant_writes');
  assert.equal((await fs.stat(corpus)).isFile(), true);
  assert.equal((await fs.readdir(home)).join(','), 'outputs.json');
});

test('offline evaluation validates CLI flags and malformed output with exit 2', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-eval-invalid-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const outputs = path.join(home, 'outputs.json');
  await fs.writeFile(outputs, '{"version":1,"results":[{"case_id":"x"}]}');
  const bad = run(home, ['memoria', 'avaliar', '--outputs', outputs]);
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /invalid_outputs/);
  const badArg = run(home, ['memoria', 'avaliar', '--outputs', outputs, '--split', 'unknown']);
  assert.equal(badArg.status, 2);
  assert.match(badArg.stderr, /invalid_arguments/);
  const help = run(home, ['memoria', 'avaliar', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /offline|Offline/i);
});

test('skills CLI uses a private snapshot for content-hash changes and does not touch installed skills', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-skill-cli-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'skills');
  const skillFile = path.join(root, 'sample', 'SKILL.md');
  await fs.mkdir(path.dirname(skillFile), { recursive: true });
  await fs.writeFile(skillFile, '---\nname: sample\n---\n# First\n');
  const snapshot = path.join(home, '.local', 'state', 'cbs', 'skills-inventory', 'snapshot.json');
  const first = run(home, ['skills', 'inventario', '--root', root, '--save-snapshot', snapshot, '--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).skills[0].change, 'unknown');
  assert.equal((await fs.stat(snapshot)).mode & 0o777, 0o600);
  const second = run(home, ['skills', 'inventario', '--root', root, '--changed', '--json']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).skills.length, 0);
  await fs.writeFile(skillFile, '---\nname: sample\n---\n# Second\n');
  const third = run(home, ['skills', 'inventario', '--root', root, '--changed', '--json']);
  assert.equal(third.status, 0, third.stderr);
  assert.equal(JSON.parse(third.stdout).skills[0].change, 'changed');
  assert.equal(await fs.readFile(skillFile, 'utf8'), '---\nname: sample\n---\n# Second\n');
});

test('skills CLI rejects arbitrary snapshot writes and malformed snapshots', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-skill-invalid-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'skills');
  await fs.mkdir(root);
  const forbidden = path.join(home, 'outside.json');
  const write = run(home, ['skills', 'inventario', '--root', root, '--save-snapshot', forbidden]);
  assert.equal(write.status, 2, write.stderr);
  assert.match(write.stderr, /snapshot_outside_cbs_state/);
  await assert.rejects(fs.stat(forbidden), { code: 'ENOENT' });
  const malformed = path.join(home, 'malformed.json');
  await fs.writeFile(malformed, '{bad');
  const read = run(home, ['skills', 'inventario', '--root', root, '--snapshot', malformed]);
  assert.equal(read.status, 2, read.stderr);
  assert.match(read.stderr, /invalid_snapshot/);
  const help = run(home, ['skills', 'inventario', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /snapshot/i);
});

test('default skill inventory includes bounded Claude and Codex plugin caches as disk evidence', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-skill-default-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const claude = path.join(home, '.claude', 'plugins', 'cache', 'vendor', 'skills', 'alpha');
  const codex = path.join(home, '.codex', 'plugins', 'cache', 'vendor', 'skills', 'beta');
  await fs.mkdir(claude, { recursive: true });
  await fs.mkdir(codex, { recursive: true });
  await fs.writeFile(path.join(claude, 'SKILL.md'), '---\nname: alpha\n---\n# Alpha\n');
  await fs.writeFile(path.join(codex, 'SKILL.md'), '---\nname: beta\n---\n# Beta\n');
  const result = run(home, ['skills', 'inventario', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.total, 2);
  assert.ok(report.skills.some(skill => skill.sources.includes('claude-plugin-cache:runtime_unverified')));
  assert.ok(report.skills.some(skill => skill.sources.includes('codex-plugin-cache:runtime_unverified')));
});
