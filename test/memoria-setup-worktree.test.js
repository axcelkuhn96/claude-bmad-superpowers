import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { activateProject } from '../base/memoria/setup.mjs';
import { verifyNativeCapture } from '../base/memoria/native.mjs';

const fingerprint = 'ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39';
const config = { provider: 'mem0', project_id: 'fixture-project',
  qdrant: { url: 'https://qdrant.internal', collection: 'fixture-project', api_key_env: 'CBS_MEMORIA_TEST_KEY' },
  embedding: { model: 'multilingual-e5-small', dimension: 384, fingerprint } };
const hash = value => createHash('sha256').update(value).digest('hex');

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-setup-worktree-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'main');
  const worktree = path.join(dir, 'worktree');
  await fs.mkdir(path.join(root, '.cbs'), { recursive: true });
  git(root, 'init', '-q');
  await fs.writeFile(path.join(root, '.cbs', 'memoria.json'), JSON.stringify(config));
  git(root, 'add', '.cbs/memoria.json');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'config');
  git(root, 'worktree', 'add', '-q', '-b', 'fixture-worktree', worktree);
  return { root, worktree, stateRoot: path.join(dir, 'state') };
}

const activation = (stateRoot, cli) => ({ stateRoot, cli, installedPlugin: true,
  lookup: async () => ['10.1.2.3'], readSecret: () => 'fixture-key',
  approve: async tuple => tuple,
  probeCollection: async (_url, _collection, key) => key ? {
    statusCode: 200, body: { result: { config: {
      params: { vectors: { size: 384, distance: 'Cosine' } },
      metadata: { cbs_embedding_fingerprint: fingerprint },
    } } },
  } : { statusCode: 401 },
  registerMcp: async () => ({ kind: 'registered' }),
});

for (const cli of ['claude', 'codex']) {
  test(`${cli} activation in worktree keeps main and active native files and snapshots separate`, async t => {
    const { root, worktree, stateRoot } = await fixture(t);
    const relative = cli === 'claude' ? '.claude/settings.local.json' : '.codex/config.toml';
    const mainFile = path.join(root, relative);
    const activeFile = path.join(worktree, relative);
    const mainInitial = cli === 'claude'
      ? { custom: 'main', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo main-user' }] }] } }
      : '[features]\nhooks = true\n';
    const activeInitial = cli === 'claude'
      ? { custom: 'active', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo active-user' }] }] } }
      : '[features]\nhooks = true\n';
    for (const [file, initial] of [[mainFile, mainInitial], [activeFile, activeInitial]]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, typeof initial === 'string' ? initial : JSON.stringify(initial));
    }
    if (cli === 'codex') {
      for (const [nativeRoot, command] of [[root, 'echo main-user'], [worktree, 'echo active-user']]) {
        await fs.writeFile(path.join(nativeRoot, '.codex/hooks.json'), JSON.stringify({ hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command }] }],
        } }));
      }
    }
    git(worktree, 'add', '-f', relative);
    if (cli === 'codex') git(worktree, 'add', '-f', '.codex/hooks.json');
    const indexBefore = git(worktree, 'ls-files', '--stage', '--', relative,
      ...(cli === 'codex' ? ['.codex/hooks.json'] : []));

    const options = { ...activation(stateRoot, cli), allowTrackedNative: true };
    assert.equal((await activateProject(root, options)).kind, 'activated');
    const mainAfter = await fs.readFile(mainFile, 'utf8');
    const mainHooksAfter = cli === 'codex' ? await fs.readFile(path.join(root, '.codex/hooks.json'), 'utf8') : null;
    assert.equal((await activateProject(worktree, options)).kind, 'activated');
    assert.equal((await verifyNativeCapture(worktree, { cli, stateRoot, projectRoot: root,
      installedPlugin: true })).kind, 'verified');
    assert.equal(git(worktree, 'ls-files', '--stage', '--', relative,
      ...(cli === 'codex' ? ['.codex/hooks.json'] : [])), indexBefore);
    assert.equal(await fs.readFile(mainFile, 'utf8'), mainAfter);
    if (cli === 'codex') assert.equal(await fs.readFile(path.join(root, '.codex/hooks.json'), 'utf8'), mainHooksAfter);

    const activeAfter = await fs.readFile(activeFile, 'utf8');
    assert.match(activeAfter, /claude-mem@/);
    if (cli === 'claude') {
      const settings = JSON.parse(activeAfter);
      assert.equal(settings.enabledPlugins['claude-mem@thedotmack'], false);
      assert.equal(settings.custom, 'active');
      assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'echo active-user');
      assert.equal(JSON.parse(mainAfter).hooks.SessionStart[0].hooks[0].command, 'echo main-user');
    } else {
      assert.match(activeAfter, /enabled = false/);
      const activeHooks = JSON.parse(await fs.readFile(path.join(worktree, '.codex/hooks.json'), 'utf8'));
      assert.equal(activeHooks.hooks.SessionStart[0].hooks[0].command, 'echo active-user');
      assert.match(mainHooksAfter, /echo main-user/);
    }

    const snapshots = path.join(stateRoot, hash(root));
    const mainSnapshot = JSON.parse(await fs.readFile(path.join(snapshots, `native-${cli}.json`), 'utf8'));
    const activeSnapshot = JSON.parse(await fs.readFile(path.join(snapshots, `native-${cli}-${hash(worktree)}.json`), 'utf8'));
    assert.equal(mainSnapshot.nativeRoot, root);
    assert.equal(activeSnapshot.nativeRoot, worktree);
    assert.equal(activeSnapshot.projectRoot, root);
  });
}

test('worktree without matching local Mem0 config cannot activate native hooks', async t => {
  const { worktree, stateRoot } = await fixture(t);
  await fs.rm(path.join(worktree, '.cbs', 'memoria.json'));
  assert.deepEqual(await activateProject(worktree, activation(stateRoot, 'claude')),
    { kind: 'blocked', reason: 'worktree_config_changed' });
  await assert.rejects(fs.access(path.join(worktree, '.claude', 'settings.local.json')), { code: 'ENOENT' });
});
