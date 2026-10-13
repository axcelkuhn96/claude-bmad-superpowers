import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import * as broker from '../base/memoria/broker.mjs';
import { encodeFrame } from '../base/memoria/frame.mjs';
import { inspectConfiguration } from '../base/memoria/provider.mjs';
import { writeLocalTrust, trustTuple } from '../base/memoria/trust.mjs';
import { RUNTIME_PINS } from '../base/memoria/runtime.mjs';
import { launchCli } from '../base/memoria/launch.mjs';
import { applyNativeExclusion } from '../base/memoria/native.mjs';

const token = 'a'.repeat(64);
const digest = createHash('sha256').update(token).digest('hex');
const secret = Buffer.alloc(32, 0x51);
function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function project(root, stateRoot, name) {
  const cwd = path.join(root, name);
  await fs.mkdir(cwd);
  git(cwd, 'init', '-q');
  await fs.writeFile(path.join(cwd, 'README'), 'fixture\n');
  git(cwd, 'add', 'README');
  git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-qm', 'fixture');
  await fs.mkdir(path.join(cwd, '.cbs'));
  await fs.writeFile(path.join(cwd, '.cbs', 'memoria.json'), JSON.stringify({
    provider: 'mem0', project_id: name,
    qdrant: { url: `https://${name}.example.test`, collection: `cbs-${name}`,
      api_key_env: `CBS_${name.toUpperCase()}_KEY` },
    embedding: { model: 'multilingual-e5-small', dimension: 384,
      fingerprint: `${RUNTIME_PINS.modelSha256}:${RUNTIME_PINS.tokenizerSha256}` },
  }));
  const resolution = await inspectConfiguration(cwd, { stateRoot });
  assert.equal(resolution.provider, 'mem0');
  await writeLocalTrust(resolution.stateDir, trustTuple(resolution));
  return { cwd, resolution };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-broker-lease-'));
  const stateRoot = path.join(root, 'state');
  const first = await project(root, stateRoot, 'first');
  const launches = path.join(stateRoot, 'launches');
  await fs.mkdir(launches, { mode: 0o700 });
  await fs.writeFile(path.join(launches, `${digest}.json`), JSON.stringify({
    cli: 'codex', nativeRoot: first.cwd, projectRoot: first.resolution.projectRoot,
    projectId: first.resolution.projectId,
    embeddingFingerprint: first.resolution.embeddingFingerprint,
    destination: first.resolution.destination, createdAt: Date.now(),
  }), { mode: 0o600 });
  await fs.writeFile(path.join(launches, `${digest}.lease`), secret, { mode: 0o600 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root: stateRoot, first };
}

async function secondLaunch(root, project) {
  const otherDigest = createHash('sha256').update('b'.repeat(64)).digest('hex');
  const launches = path.join(root, 'launches');
  const first = JSON.parse(await fs.readFile(path.join(launches, `${digest}.json`), 'utf8'));
  const record = { ...first, nativeRoot: project.cwd,
    projectRoot: project.resolution.projectRoot, projectId: project.resolution.projectId,
    embeddingFingerprint: project.resolution.embeddingFingerprint,
    destination: project.resolution.destination };
  await fs.writeFile(path.join(launches, `${otherDigest}.json`), JSON.stringify(record), { mode: 0o600 });
  await fs.writeFile(path.join(launches, `${otherDigest}.lease`), secret, { mode: 0o600 });
  return otherDigest;
}

test('a valid launch token holds an idle broker for the live CLI and releases it on exit', async t => {
  const { root, first } = await fixture(t);
  const second = await project(path.dirname(root), root, 'second');
  const otherDigest = await secondLaunch(root, second);
  const file = path.join(root, 'encoder.sock');
  let connections = 0;
  let idle;
  let firstLease;
  let secondLease;
  const server = net.createServer(socket => {
    connections++;
    clearTimeout(idle);
    broker.readBrokerRequest(socket, async frame => {
      const accepted = await broker.authorizeBrokerLease(root, frame.value.cwd, first.resolution,
        frame.value.launchDigest, frame.secret);
      frame.secret.fill(0);
      if (accepted) socket.write(encodeFrame({ kind: 'leased' }, undefined, true));
      else socket.end(encodeFrame({ kind: 'unavailable', reason: 'lease_invalid' }, undefined, true));
    });
    socket.once('close', () => {
      connections--;
      if (!connections) idle = setTimeout(() => server.close(), 25);
    });
  });
  t.after(() => {
    clearTimeout(idle);
    firstLease?.release();
    secondLease?.release();
    server.closeAllConnections?.();
    server.close();
  });
  await new Promise(resolve => server.listen(file, resolve));
  await fs.chmod(file, 0o600);
  firstLease = await broker.openBrokerLease(first.cwd, digest, secret,
    { stateRoot: root, deadlineMs: 500 });
  secondLease = await broker.openBrokerLease(second.cwd, otherDigest, secret,
    { stateRoot: root, deadlineMs: 500 });
  assert.equal(firstLease.kind, 'leased');
  assert.equal(secondLease.kind, 'leased');
  const replay = await broker.openBrokerLease(first.cwd, digest, secret,
    { stateRoot: root, deadlineMs: 500 });
  assert.deepEqual(replay, { kind: 'unavailable', reason: 'lease_invalid' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(server.listening, true);
  assert.equal(connections, 2);
  firstLease.release();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(server.listening, true);
  secondLease.release();
  await new Promise(resolve => server.once('close', resolve));
  assert.equal(connections, 0);
});

test('a forged, closed or mismatched launch cannot hold a broker socket', async t => {
  const { root, first } = await fixture(t);
  const verify = value => broker.authorizeBrokerLease(root, first.cwd,
    first.resolution, digest, value);
  assert.equal(await verify(Buffer.alloc(32, 0x52)), false);
  const second = await project(path.dirname(root), root, 'second');
  assert.equal(await broker.authorizeBrokerLease(root, second.cwd,
    first.resolution, digest, secret), false);
  assert.equal(await broker.authorizeBrokerLease(root, first.cwd,
    { ...first.resolution, embeddingFingerprint: 'other' }, digest, secret), false);
  const file = path.join(root, 'launches', `${digest}.lease`);
  await fs.chmod(file, 0o644);
  assert.equal(await verify(secret), false);
  await fs.chmod(file, 0o600);
  await fs.rm(file);
  await fs.symlink(path.join(root, 'launches', `${digest}.json`), file);
  assert.equal(await verify(secret), false);
  await fs.rm(file);
  await fs.writeFile(file, secret, { mode: 0o600 });
  await fs.writeFile(path.join(root, 'launches', `${digest}.closed`), '{}', { mode: 0o600 });
  assert.equal(await verify(secret), false);
});

test('a launch from a project subdirectory binds to its canonical checkout', async t => {
  const { root, first } = await fixture(t);
  const child = path.join(first.cwd, 'src');
  await fs.mkdir(child);
  assert.equal(await broker.authorizeBrokerLease(root, child, first.resolution,
    digest, secret), true);
  assert.equal(await fs.access(path.join(root, 'launches', `${digest}.lease`))
    .then(() => true, () => false), false);
});

test('a changed project trust cannot consume a launch lease', async t => {
  const { root, first } = await fixture(t);
  await writeLocalTrust(first.resolution.stateDir, {
    ...trustTuple(first.resolution), collection: 'changed',
  });
  assert.equal(await broker.authorizeBrokerLease(root, first.cwd, first.resolution,
    digest, secret), false);
  assert.equal(await fs.access(path.join(root, 'launches', `${digest}.lease`))
    .then(() => true, () => false), true);
});

test('two opted-in projects launch concurrently through one broker and release independently', async t => {
  const { root, first } = await fixture(t);
  const second = await project(path.dirname(root), root, 'second');
  for (const current of [first, second]) {
    assert.equal((await applyNativeExclusion(current.cwd, { cli: 'codex', stateRoot: root,
      installedPlugin: true, projectRoot: current.cwd })).kind, 'applied');
  }
  assert.notEqual(first.resolution.destination.collection, second.resolution.destination.collection);
  assert.notEqual(first.resolution.destination.apiKeyEnv, second.resolution.destination.apiKeyEnv);
  const leases = new Set();
  const server = net.createServer(socket => {
    broker.readBrokerRequest(socket, async frame => {
      const accepted = frame.value.kind === 'launch_lease' &&
        await broker.authorizeBrokerLease(root, frame.value.cwd, first.resolution,
          frame.value.launchDigest, frame.secret);
      frame.secret.fill(0);
      if (!accepted) socket.end(encodeFrame({ kind: 'unavailable', reason: 'lease_invalid' },
        undefined, true));
      else { leases.add(socket); socket.write(encodeFrame({ kind: 'leased' }, undefined, true)); }
    });
    socket.once('close', () => leases.delete(socket));
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await new Promise(resolve => server.listen(broker.brokerPath(root), resolve));
  await fs.chmod(broker.brokerPath(root), 0o600);
  const bin = path.join(path.dirname(root), 'bin');
  await fs.mkdir(bin);
  const cli = path.join(bin, 'codex');
  await fs.writeFile(cli, `#!${process.execPath}\nconst fs = require('node:fs');
const path = require('node:path');
const root = process.env.CBS_TEST_LEASE_CONTROL;
const name = path.basename(process.cwd());
fs.writeFileSync(path.join(root, name + '.ready'), '');
const poll = setInterval(() => {
  if (fs.existsSync(path.join(root, name + '.release'))) clearInterval(poll);
}, 10);
setTimeout(() => process.exit(2), 5000).unref();\n`);
  await fs.chmod(cli, 0o700);
  const oldPath = process.env.PATH;
  const oldControl = process.env.CBS_TEST_LEASE_CONTROL;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  process.env.CBS_TEST_LEASE_CONTROL = path.dirname(root);
  t.after(async () => {
    await Promise.all(['first', 'second'].map(name => fs.writeFile(path.join(path.dirname(root),
      `${name}.release`), '').catch(() => {})));
    process.env.PATH = oldPath;
    if (oldControl === undefined) delete process.env.CBS_TEST_LEASE_CONTROL;
    else process.env.CBS_TEST_LEASE_CONTROL = oldControl;
  });
  const runningFirst = launchCli(first.cwd, 'codex', [], { stateRoot: root });
  const runningSecond = launchCli(second.cwd, 'codex', [], { stateRoot: root });
  const waitFor = async predicate => {
    for (let i = 0; i < 200; i++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('lease_fixture_timeout');
  };
  await waitFor(async () => leases.size === 2 && await Promise.all(['first', 'second'].map(name =>
    fs.access(path.join(path.dirname(root), `${name}.ready`)).then(() => true, () => false)))
    .then(values => values.every(Boolean)));
  await fs.writeFile(path.join(path.dirname(root), 'first.release'), '');
  assert.deepEqual(await runningFirst, { kind: 'exited', code: 0, signal: null });
  await waitFor(() => leases.size === 1);
  assert.equal(server.listening, true);
  await fs.writeFile(path.join(path.dirname(root), 'second.release'), '');
  assert.deepEqual(await runningSecond, { kind: 'exited', code: 0, signal: null });
  await waitFor(() => leases.size === 0);
});

test('an ACK timeout closes the prospective lease without retaining a socket', async t => {
  const { root, first } = await fixture(t);
  const file = path.join(root, 'encoder.sock');
  let open = 0;
  const server = net.createServer(socket => {
    open++;
    broker.readBrokerRequest(socket, frame => frame.secret.fill(0));
    socket.once('close', () => open--);
  });
  t.after(() => server.close());
  await new Promise(resolve => server.listen(file, resolve));
  await fs.chmod(file, 0o600);
  assert.deepEqual(await broker.openBrokerLease(first.cwd, digest, secret,
    { stateRoot: root, deadlineMs: 60 }), { kind: 'unavailable', reason: 'broker_unavailable' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(open, 0);
});

test('a lease socket closes when its owner releases it without sending another request', async t => {
  const { root, first } = await fixture(t);
  const file = path.join(root, 'encoder.sock');
  const server = net.createServer(socket => broker.readBrokerRequest(socket, frame => {
    frame.secret.fill(0);
    socket.write(encodeFrame({ kind: 'leased' }, undefined, true));
  }));
  t.after(() => server.close());
  await new Promise(resolve => server.listen(file, resolve));
  await fs.chmod(file, 0o600);
  const lease = await broker.openBrokerLease(first.cwd, digest, secret,
    { stateRoot: root, deadlineMs: 500 });
  assert.equal(lease.kind, 'leased');
  const closed = new Promise(resolve => server.getConnections((error, n) => {
    assert.ifError(error);
    assert.equal(n, 1);
    server.once('close', resolve);
  }));
  lease.release();
  server.close();
  await closed;
});

test('an exited launcher process releases its lease socket without a PID cleanup', async t => {
  const { root, first } = await fixture(t);
  const file = path.join(root, 'encoder.sock');
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const server = net.createServer(socket => {
    broker.readBrokerRequest(socket, async frame => {
      const accepted = await broker.authorizeBrokerLease(root, frame.value.cwd, first.resolution,
        frame.value.launchDigest, frame.secret);
      frame.secret.fill(0);
      if (accepted) socket.write(encodeFrame({ kind: 'leased' }, undefined, true));
      else socket.end(encodeFrame({ kind: 'unavailable' }, undefined, true));
    });
    socket.once('close', closed);
  });
  t.after(() => server.close());
  await new Promise(resolve => server.listen(file, resolve));
  await fs.chmod(file, 0o600);
  const module = new URL('../base/memoria/broker.mjs', import.meta.url).href;
  const code = `import { openBrokerLease } from ${JSON.stringify(module)};
    const lease = await openBrokerLease(${JSON.stringify(first.cwd)}, ${JSON.stringify(digest)},
      Buffer.alloc(32, 0x51), { stateRoot: ${JSON.stringify(root)}, deadlineMs: 500 });
    process.exit(lease.kind === 'leased' ? 0 : 2);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  const codeResult = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(codeResult, 0);
  await Promise.race([disconnected,
    new Promise((_, reject) => setTimeout(() => reject(new Error('orphan_lease_socket')), 500))]);
  assert.equal(await fs.access(path.join(root, 'launches', `${digest}.lease`))
    .then(() => true, () => false), false);
});
