import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureBrokerReady } from '../base/memoria/broker-start.mjs';
import { inspectConfiguration, initializeSession } from '../base/memoria/provider.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-broker-start-'));
  const cwd = path.join(temp, 'project');
  const stateRoot = path.join(temp, 'state');
  await fs.mkdir(path.join(cwd, '.cbs'), { recursive: true });
  const git = spawnSync('git', ['init', '-q', cwd]);
  assert.equal(git.status, 0);
  await fs.writeFile(path.join(cwd, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: 'fixture',
    qdrant: { url: 'https://qdrant.example.test', collection: 'cbs-fixture',
      api_key_env: 'CBS_TEST_KEY' },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  const current = await inspectConfiguration(cwd, { stateRoot });
  await writeLocalTrust(current.stateDir, trustTuple(current));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  return { cwd, stateRoot, current };
}

async function endpoint(t, root) {
  const server = net.createServer(socket => socket.end());
  const file = path.join(root, 'encoder.sock');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await new Promise((resolve, reject) => server.listen(file, error => error ? reject(error) : resolve()));
  await fs.chmod(file, 0o600);
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server;
}

test('two authenticated callers wait for one cold broker startup and observe its real endpoint', async t => {
  const { cwd, stateRoot } = await fixture(t);
  assert.equal((await initializeSession(cwd, 'native-1', { stateRoot,
    event: 'SessionStart', cli: 'claude' })).provider, 'mem0');
  let starts = 0;
  const spawnBroker = (_command, args, options) => {
    starts++;
    assert.equal(args.includes('native-1'), false);
    assert.equal('CBS_TEST_KEY' in options.env, false);
    setTimeout(() => { endpoint(t, stateRoot).catch(() => {}); }, 30);
    return { unref() {} };
  };
  const options = { stateRoot, bootstrapSessionId: 'native-1', deadlineMs: 1000, spawnBroker };
  const [first, second] = await Promise.all([
    ensureBrokerReady(cwd, options), ensureBrokerReady(cwd, options),
  ]);
  assert.deepEqual(first, { kind: 'ready' });
  assert.deepEqual(second, { kind: 'ready' });
  assert.equal(starts, 1);
});

test('a fresh native session cannot start a broker', async t => {
  const { cwd, stateRoot } = await fixture(t);
  let starts = 0;
  const result = await ensureBrokerReady(cwd, { stateRoot, bootstrapSessionId: 'unseen',
    deadlineMs: 100, spawnBroker: () => { starts++; } });
  assert.deepEqual(result, { kind: 'blocked', reason: 'fresh_session' });
  assert.equal(starts, 0);
});

test('changed trust and unsafe endpoint fail closed without spawning', async t => {
  const { cwd, stateRoot, current } = await fixture(t);
  let starts = 0;
  const spawnBroker = () => { starts++; };
  await writeLocalTrust(current.stateDir, { ...trustTuple(current), collection: 'changed' });
  assert.deepEqual(await ensureBrokerReady(cwd, { stateRoot, spawnBroker }),
    { kind: 'blocked', reason: 'trust_changed' });
  await writeLocalTrust(current.stateDir, trustTuple(current));
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stateRoot, 'encoder.sock'), 'not a socket');
  assert.deepEqual(await ensureBrokerReady(cwd, { stateRoot, spawnBroker }),
    { kind: 'blocked', reason: 'unsafe_broker' });
  assert.equal(starts, 0);
});
