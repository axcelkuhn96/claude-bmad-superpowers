import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as moduleApi from 'node:module';
import { ensureBrokerReady } from '../base/memoria/broker-start.mjs';
import { inspectConfiguration, initializeSession } from '../base/memoria/provider.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';
import { FrameReader, encodeFrame } from '../base/memoria/frame.mjs';

const brokerEntrypoint = fileURLToPath(new URL('../base/memoria/broker.mjs', import.meta.url));
const brokerLoaderSupported = typeof moduleApi.registerHooks === 'function';

function brokerEntrypointWithStub(serveBody) {
  const replacement = `export async function serveBroker() {\n${serveBody}\n}\n`;
  const loader = `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url !== ${JSON.stringify(new URL('../base/memoria/broker.mjs', import.meta.url).href)}) return loaded;
  const source = String(loaded.source);
  const start = source.indexOf('export async function serveBroker(');
  const end = source.indexOf('\\nif (process.argv[1] === fileURLToPath(import.meta.url))', start);
  if (start < 0 || end < 0) throw new Error('broker_stub_anchor_missing');
  return { ...loaded, source: source.slice(0, start) + ${JSON.stringify(replacement)} + source.slice(end) };
} });`;
  const preload = `data:text/javascript;base64,${Buffer.from(loader).toString('base64')}`;
  return spawnSync(process.execPath, [`--import=${preload}`, brokerEntrypoint], {
    encoding: 'utf8', timeout: 5000,
  });
}

test('broker entrypoint lets conversation proof import complete while server promise remains active',
  { skip: !brokerLoaderSupported }, () => {
  const child = brokerEntrypointWithStub(`
    const loaded = Promise.all([import('./conversation-proof.mjs'), import('./candidates.mjs')])
      .then(() => process.stdout.write('imports:resolved\\n'));
    await Promise.race([loaded, new Promise(resolve => setTimeout(resolve, 1000))]);
    process.stdout.write('serve:ended\\n');`);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^imports:resolved\nserve:ended\n$/);
});

test('broker entrypoint reports an unexpected server failure', { skip: !brokerLoaderSupported }, () => {
  const child = brokerEntrypointWithStub(`throw new Error('fixture_broker_failure');`);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1, child.stderr);
});

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

async function endpoint(t, root, device = 'auto') {
  const server = net.createServer(socket => {
    const reader = new FrameReader();
    socket.on('data', chunk => {
      for (const frame of reader.push(chunk)) {
        socket.end(encodeFrame({ kind: 'device_status', requested: device }, undefined, true));
        frame.secret.fill(0);
      }
    });
  });
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

test('broker launch carries embedding device from the native process allowlist', async t => {
  const { cwd, stateRoot } = await fixture(t);
  const previous = process.env.CBS_MEMORIA_EMBEDDING_DEVICE;
  process.env.CBS_MEMORIA_EMBEDDING_DEVICE = 'cpu';
  t.after(() => {
    if (previous === undefined) delete process.env.CBS_MEMORIA_EMBEDDING_DEVICE;
    else process.env.CBS_MEMORIA_EMBEDDING_DEVICE = previous;
  });
  let captured;
  await ensureBrokerReady(cwd, { stateRoot, deadlineMs: 1000,
    spawnBroker: (_command, _args, options) => {
      captured = options.env;
      setTimeout(() => { endpoint(t, stateRoot, 'cpu').catch(() => {}); }, 10);
      return { unref() {} };
    } });
  assert.equal(captured.CBS_MEMORIA_EMBEDDING_DEVICE, 'cpu');
  assert.equal(captured.OPENAI_API_KEY, undefined);
});

test('a live broker rejects a conflicting explicit device without replacement', async t => {
  const { cwd, stateRoot } = await fixture(t);
  await endpoint(t, stateRoot, 'auto');
  const previous = process.env.CBS_MEMORIA_EMBEDDING_DEVICE;
  process.env.CBS_MEMORIA_EMBEDDING_DEVICE = 'cpu';
  t.after(() => {
    if (previous === undefined) delete process.env.CBS_MEMORIA_EMBEDDING_DEVICE;
    else process.env.CBS_MEMORIA_EMBEDDING_DEVICE = previous;
  });
  let starts = 0;
  assert.deepEqual(await ensureBrokerReady(cwd, { stateRoot,
    spawnBroker: () => { starts++; } }), { kind: 'blocked', reason: 'device_conflict' });
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
