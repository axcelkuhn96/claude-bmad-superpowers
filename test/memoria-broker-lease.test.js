import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as broker from '../base/memoria/broker.mjs';
import { encodeFrame } from '../base/memoria/frame.mjs';

const token = 'a'.repeat(64);
const digest = createHash('sha256').update(token).digest('hex');
const secret = Buffer.alloc(32, 0x51);
const resolution = { projectRoot: '/checkout', projectId: 'project',
  embeddingFingerprint: 'model:tokenizer', destination: { url: 'https://qdrant.local', collection: 'p' } };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-broker-lease-'));
  const launches = path.join(root, 'launches');
  await fs.mkdir(launches, { mode: 0o700 });
  await fs.writeFile(path.join(launches, `${digest}.json`), JSON.stringify({
    cli: 'codex', nativeRoot: '/checkout', projectRoot: resolution.projectRoot,
    projectId: resolution.projectId, embeddingFingerprint: resolution.embeddingFingerprint,
    destination: resolution.destination, createdAt: Date.now(),
  }), { mode: 0o600 });
  await fs.writeFile(path.join(launches, `${digest}.lease`), secret, { mode: 0o600 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function secondLaunch(root) {
  const otherDigest = createHash('sha256').update('b'.repeat(64)).digest('hex');
  const launches = path.join(root, 'launches');
  const first = JSON.parse(await fs.readFile(path.join(launches, `${digest}.json`), 'utf8'));
  await fs.writeFile(path.join(launches, `${otherDigest}.json`), JSON.stringify(first), { mode: 0o600 });
  await fs.writeFile(path.join(launches, `${otherDigest}.lease`), secret, { mode: 0o600 });
  return otherDigest;
}

test('a valid launch token holds an idle broker for the live CLI and releases it on exit', async t => {
  const root = await fixture(t);
  const otherDigest = await secondLaunch(root);
  const file = path.join(root, 'encoder.sock');
  let connections = 0;
  let idle;
  const server = net.createServer(socket => {
    connections++;
    clearTimeout(idle);
    broker.readBrokerRequest(socket, async frame => {
      const accepted = await broker.authorizeBrokerLease(root, '/checkout', resolution,
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
  t.after(async () => { clearTimeout(idle); server.close(); });
  await new Promise(resolve => server.listen(file, resolve));
  await fs.chmod(file, 0o600);
  const first = await broker.openBrokerLease('/checkout', digest, secret,
    { stateRoot: root, deadlineMs: 500 });
  const second = await broker.openBrokerLease('/checkout', otherDigest, secret,
    { stateRoot: root, deadlineMs: 500 });
  assert.equal(first.kind, 'leased');
  assert.equal(second.kind, 'leased');
  const replay = await broker.openBrokerLease('/checkout', digest, secret,
    { stateRoot: root, deadlineMs: 500 });
  assert.deepEqual(replay, { kind: 'unavailable', reason: 'lease_invalid' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(server.listening, true);
  assert.equal(connections, 2);
  first.release();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(server.listening, true);
  second.release();
  await new Promise(resolve => server.once('close', resolve));
  assert.equal(connections, 0);
});

test('a forged, closed or mismatched launch cannot hold a broker socket', async t => {
  const root = await fixture(t);
  const verify = value => broker.authorizeBrokerLease(root, '/checkout', resolution, digest, value);
  assert.equal(await verify(Buffer.alloc(32, 0x52)), false);
  assert.equal(await broker.authorizeBrokerLease(root, '/other', resolution, digest, secret), false);
  assert.equal(await broker.authorizeBrokerLease(root, '/checkout',
    { ...resolution, projectId: 'other' }, digest, secret), false);
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

test('an ACK timeout closes the prospective lease without retaining a socket', async t => {
  const root = await fixture(t);
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
  assert.deepEqual(await broker.openBrokerLease('/checkout', digest, secret,
    { stateRoot: root, deadlineMs: 60 }), { kind: 'unavailable', reason: 'broker_unavailable' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(open, 0);
});

test('a lease socket closes when its owner releases it without sending another request', async t => {
  const root = await fixture(t);
  const file = path.join(root, 'encoder.sock');
  const server = net.createServer(socket => broker.readBrokerRequest(socket, frame => {
    frame.secret.fill(0);
    socket.write(encodeFrame({ kind: 'leased' }, undefined, true));
  }));
  t.after(() => server.close());
  await new Promise(resolve => server.listen(file, resolve));
  await fs.chmod(file, 0o600);
  const lease = await broker.openBrokerLease('/checkout', digest, secret,
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
  const root = await fixture(t);
  const file = path.join(root, 'encoder.sock');
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const server = net.createServer(socket => {
    broker.readBrokerRequest(socket, async frame => {
      const accepted = await broker.authorizeBrokerLease(root, '/checkout', resolution,
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
    const lease = await openBrokerLease('/checkout', ${JSON.stringify(digest)},
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
