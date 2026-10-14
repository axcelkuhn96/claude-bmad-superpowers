import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventorySkills } from '../src/skill-inventory.js';

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-skill-inventory-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function skill(dir, name, body) {
  const location = path.join(dir, name);
  await fs.mkdir(location, { recursive: true });
  await fs.writeFile(path.join(location, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n\n${body}\n`);
  return location;
}

test('first inventory is an unknown baseline, then content hashes detect unchanged and changed despite mtime', async (t) => {
  const root = await temp(t);
  const location = await skill(root, 'alpha', '# Skill\nSee `references/guide.md`.');
  await fs.mkdir(path.join(location, 'references'));
  await fs.writeFile(path.join(location, 'references', 'guide.md'), 'guide');
  const baseline = await inventorySkills({ roots: [root] });
  assert.equal(baseline.skills.length, 1);
  assert.equal(baseline.skills[0].change, 'unknown');
  assert.equal(baseline.skills[0].changedSincePrior, null);
  assert.equal(baseline.skills[0].usage, 'unmeasured');
  assert.equal(baseline.skills[0].references[0].status, 'available');
  const initialStat = await fs.stat(path.join(location, 'SKILL.md'));
  await fs.utimes(path.join(location, 'SKILL.md'), new Date(1), new Date(1));
  const same = await inventorySkills({ roots: [root], previous: baseline });
  assert.equal(same.skills[0].change, 'unchanged');
  assert.equal(same.skills[0].hash, baseline.skills[0].hash);
  await fs.writeFile(path.join(location, 'SKILL.md'), '---\nname: alpha\n---\n\n# Changed\n');
  await fs.utimes(path.join(location, 'SKILL.md'), initialStat.atime, initialStat.mtime);
  const changed = await inventorySkills({ roots: [root], previous: same });
  assert.equal(changed.skills[0].change, 'changed');
  assert.equal(changed.skills[0].changedSincePrior, true);
  assert.equal(changed.skills[0].bodyChangedSincePrior, true);
  assert.notEqual(changed.skills[0].hash, same.skills[0].hash);
});

test('metadata edits leave body hash unchanged', async (t) => {
  const root = await temp(t);
  const location = await skill(root, 'alpha', '# Stable');
  const first = await inventorySkills({ roots: [root] });
  await fs.writeFile(path.join(location, 'SKILL.md'), '---\nname: alpha\ndescription: edited\n---\n\n# Stable\n');
  const second = await inventorySkills({ roots: [root], previous: first });
  assert.equal(second.skills[0].change, 'changed');
  assert.equal(second.skills[0].bodyChangedSincePrior, false);
});

test('reports added and removed skills, missing roots and duplicate symlink aliases without following loops', async (t) => {
  const root = await temp(t);
  const skillA = await skill(root, 'a', '# A');
  await fs.symlink(skillA, path.join(root, 'alias'));
  await fs.symlink(root, path.join(root, 'cycle'));
  const missing = await inventorySkills({ roots: [root, path.join(root, 'absent')] });
  assert.deepEqual(missing.missingRoots, [path.join(root, 'absent')]);
  const first = await inventorySkills({ roots: [root] });
  assert.equal(first.skills.length, 1);
  assert.equal(first.skills[0].aliases.length, 2);
  await skill(root, 'b', '# B');
  const second = await inventorySkills({ roots: [root], previous: first });
  assert.equal(second.summary.added, 1);
  await fs.rm(skillA, { recursive: true });
  await fs.rm(path.join(root, 'alias'));
  const third = await inventorySkills({ roots: [root], previous: second });
  assert.equal(third.summary.deleted, 1);
  assert.equal(third.deleted[0].declaredName, 'a');
});

test('references report availability but never read or disclose outside or sensitive targets', async (t) => {
  const root = await temp(t);
  const outside = path.join(root, 'outside.md');
  await fs.writeFile(outside, 'SECRET_VALUE_NEVER_REPORT');
  const location = await skill(root, 'safe', '# Safe\n[missing](references/missing.md) [outside](../outside.md) [secret](./private-token.txt) [web](https://example.com/x)');
  await fs.writeFile(path.join(location, 'private-token.txt'), 'SECRET_VALUE_NEVER_REPORT');
  const result = await inventorySkills({ roots: [location] });
  assert.deepEqual(result.skills[0].references.map((ref) => ref.status).sort(), ['missing', 'outside_scope', 'sensitive'].sort());
  assert.doesNotMatch(JSON.stringify(result), /SECRET_VALUE_NEVER_REPORT|private-token\.txt|outside\.md/);
});

test('known structure contracts flag missing headings and changed reviewed hash without claiming semantic compatibility', async (t) => {
  const root = await temp(t);
  await skill(root, 'taste', '# Taste\nSee `references/quality.md`.');
  const result = await inventorySkills({ roots: [root], reviewedSources: [{ name: 'taste', sha256: '0'.repeat(64), requiredHeadings: ['Taste', 'Workflow'], requiredReferences: ['references/quality.md'] }] });
  assert.equal(result.skills[0].contracts[0].reviewedHashMatch, false);
  assert.deepEqual(result.skills[0].contracts[0].missingHeadings, ['Workflow']);
  assert.deepEqual(result.skills[0].contracts[0].missingReferences, ['references/quality.md']);
  assert.equal(result.skills[0].contracts[0].semanticCompatibility, 'unverified');
  assert.equal(result.skills[0].usage, 'unmeasured');
});

test('same declared name with different content is informational divergence', async (t) => {
  const root = await temp(t);
  const first = await skill(path.join(root, 'one'), 'taste', '# First');
  const second = await skill(path.join(root, 'two'), 'taste', '# Second');
  const report = await inventorySkills({ roots: [first, second] });
  assert.equal(report.skills.length, 2);
  assert.equal(report.divergences.length, 1);
  assert.equal(report.divergences[0].severity, 'info');
});

test('rejects unbounded roots and avoids traversing outside symlink trees', async (t) => {
  const root = await temp(t);
  const outside = await temp(t);
  await skill(outside, 'hidden', '# Hidden');
  await fs.symlink(outside, path.join(root, 'external'));
  const report = await inventorySkills({ roots: [root] });
  assert.equal(report.skills.length, 0);
  await assert.rejects(inventorySkills({ roots: [path.parse(root).root] }), /too broad/);
});

test('rejects an explicit symlink root whose canonical target is HOME', async (t) => {
  const root = await temp(t);
  const alias = path.join(root, 'home-alias');
  await fs.symlink(root, alias);
  const originalHome = process.env.HOME;
  process.env.HOME = root;
  try {
    await assert.rejects(inventorySkills({ roots: [alias] }), /too broad/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('never reads a child SKILL.md or directory symlink outside the explicit root', async (t) => {
  const root = await temp(t);
  const outside = await temp(t);
  const external = await skill(outside, 'external', '# PRIVATE_EXTERNAL_HEADING');
  await fs.symlink(external, path.join(root, 'linked-directory'));
  await fs.mkdir(path.join(root, 'linked-file'));
  await fs.symlink(path.join(external, 'SKILL.md'), path.join(root, 'linked-file', 'SKILL.md'));
  const report = await inventorySkills({ roots: [root] });
  assert.equal(report.skills.length, 0);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_EXTERNAL_HEADING/);
  const trusted = await inventorySkills({ roots: [path.join(root, 'linked-directory'), path.join(root, 'linked-file', 'SKILL.md')] });
  assert.equal(trusted.skills.length, 1);
  assert.deepEqual(trusted.skills[0].headings, ['PRIVATE_EXTERNAL_HEADING']);
});

test('only matching complete scan scopes prove deletion; prior entries otherwise remain unobserved', async (t) => {
  const root = await temp(t);
  const other = await temp(t);
  const location = await skill(root, 'a', '# A');
  const first = await inventorySkills({ roots: [root] });
  const changedScope = await inventorySkills({ roots: [other], previous: first });
  assert.equal(changedScope.scopeChanged, true);
  assert.equal(changedScope.summary.deleted, 0);
  assert.equal(changedScope.unobserved.length, 1);
  const legacy = await inventorySkills({ roots: [root], previous: { skills: first.skills } });
  assert.equal(legacy.scopeChanged, true);
  assert.equal(legacy.skills[0].change, 'unchanged');
  await fs.rename(root, `${root}-hidden`);
  t.after(() => fs.rename(`${root}-hidden`, root).catch(() => {}));
  const missing = await inventorySkills({ roots: [root], previous: first });
  assert.equal(missing.summary.deleted, 0);
  assert.equal(missing.unobserved.length, 1);
  await fs.rename(`${root}-hidden`, root);
  let nested = root;
  for (let i = 0; i < 8; i++) {
    nested = path.join(nested, `level-${i}`);
    await fs.mkdir(nested);
  }
  await fs.rm(location, { recursive: true });
  const truncated = await inventorySkills({ roots: [root], previous: first });
  assert.ok(truncated.limits.depthLimited > 0);
  assert.equal(truncated.summary.deleted, 0);
  assert.equal(truncated.unobserved.length, 1);
  await fs.rm(path.join(root, 'level-0'), { recursive: true });
  const removed = await inventorySkills({ roots: [root], previous: first });
  assert.equal(removed.scopeChanged, false);
  assert.equal(removed.summary.deleted, 1);
  assert.equal(removed.unobserved.length, 0);
});

test('stable missing optional roots and leaf at max depth still permit comparison', async (t) => {
  const root = await temp(t);
  const absent = path.join(root, 'optional-absent');
  let nested = root;
  for (let i = 0; i < 6; i++) {
    nested = path.join(nested, `level-${i}`);
    await fs.mkdir(nested);
  }
  await skill(nested, 'first', '# First');
  const first = await inventorySkills({ roots: [root, absent] });
  assert.equal(first.scope.complete, true);
  assert.equal(first.limits.depthLimited, 0);
  await skill(root, 'second', '# Second');
  const second = await inventorySkills({ roots: [root, absent], previous: first });
  assert.equal(second.baseline, 'compared');
  assert.equal(second.summary.added, 1);
});

test('required references pass only when available inside the skill directory', async (t) => {
  const root = await temp(t);
  const outside = await temp(t);
  const location = await skill(root, 'contract', '# Contract\n[Guide](references/guide.md)');
  const contract = [{ name: 'contract', requiredReferences: ['references/guide.md'] }];
  const missing = await inventorySkills({ roots: [root], reviewedSources: contract });
  assert.deepEqual(missing.skills[0].contracts[0].missingReferences, ['references/guide.md']);
  await fs.mkdir(path.join(location, 'references'));
  await fs.writeFile(path.join(location, 'references', 'guide.md'), 'ok');
  const available = await inventorySkills({ roots: [root], reviewedSources: contract });
  assert.deepEqual(available.skills[0].contracts[0].missingReferences, []);
  await fs.rm(path.join(location, 'references', 'guide.md'));
  await fs.writeFile(path.join(outside, 'guide.md'), 'outside');
  await fs.symlink(path.join(outside, 'guide.md'), path.join(location, 'references', 'guide.md'));
  const escaped = await inventorySkills({ roots: [root], reviewedSources: contract });
  assert.deepEqual(escaped.skills[0].contracts[0].missingReferences, ['references/guide.md']);
});
