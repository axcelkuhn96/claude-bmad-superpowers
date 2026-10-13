import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectConfiguration } from '../base/memoria/provider.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';

test('status and check report removed and changed pinned address as untrusted', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-status-address-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  await fs.mkdir(path.join(project, '.cbs'), { recursive: true });
  const git = spawnSync('git', ['init', '-q', project], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const configFile = path.join(project, '.cbs', 'memoria.json');
  const config = address => ({ provider: 'mem0', project_id: 'p',
    qdrant: { url: 'https://qdrant.internal', collection: 'cbs-p', api_key_env: 'CBS_STATUS_TEST_KEY',
      ...(address === undefined ? {} : { address }) },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` } });
  const setConfig = address => fs.writeFile(configFile, JSON.stringify(config(address)));
  const stateRoot = path.join(home, '.local', 'state', 'cbs', 'memoria');
  const cli = new URL('../bin/cli.js', import.meta.url).pathname;
  const run = action => {
    const child = spawnSync(process.execPath, [cli, 'memoria', action, '--project', project],
      { encoding: 'utf8', env: { ...process.env, HOME: home, CBS_STATUS_TEST_KEY: '' } });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return JSON.parse(child.stdout).trusted;
  };

  await setConfig('10.8.0.3');
  const resolution = await inspectConfiguration(project, { stateRoot });
  assert.equal(resolution.provider, 'mem0');
  await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
  assert.equal(run('status'), true);
  await setConfig();
  assert.equal(run('status'), false);
  assert.equal(run('check'), false);
  await setConfig('10.8.0.4');
  assert.equal(run('status'), false);

  await writeLocalTrust(resolution.stateDir, { ...trustTuple(resolution), address: '10.8.0.4' });
  assert.equal(run('check'), true);
  await writeLocalTrust(resolution.stateDir, { ...trustTuple(resolution), address: undefined });
  await setConfig();
  assert.equal(run('status'), true);
  await setConfig('10.8.0.3');
  assert.equal(run('check'), false);
});
