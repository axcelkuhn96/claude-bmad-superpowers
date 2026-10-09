import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { authenticateWindowsClient, authenticateWindowsServer, newWindowsDiscovery,
  parseWindowsDiscovery } from '../base/memoria/windows-transport.mjs';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const close = server => new Promise(resolve => server.close(resolve));
const connect = port => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => resolve(socket));
  socket.once('error', reject);
});

test('Windows discovery binds numeric loopback, port, generation and capability', () => {
  const one = newWindowsDiscovery(18001);
  const two = newWindowsDiscovery(18001);
  assert.equal(one.host, '127.0.0.1');
  assert.notEqual(one.generation, two.generation);
  assert.notEqual(one.capability, two.capability);
  assert.deepEqual(parseWindowsDiscovery(JSON.stringify(one)), one);
  assert.throws(() => parseWindowsDiscovery(JSON.stringify({ ...one, host: 'localhost' })));
  assert.throws(() => parseWindowsDiscovery(JSON.stringify({ ...one, extra: true })));
});

test('mutual Windows handshake completes before application bytes', async () => {
  let received = '';
  let serverDone;
  const server = net.createServer(socket => {
    serverDone = (async () => {
      const discovery = server.discovery;
      await authenticateWindowsServer(socket, discovery, Date.now() + 1000);
      socket.once('data', chunk => { received += chunk.toString('utf8'); socket.end(); });
      socket.resume();
    })();
  });
  await listen(server);
  server.discovery = newWindowsDiscovery(server.address().port);
  const client = await connect(server.address().port);
  try {
    await authenticateWindowsClient(client, server.discovery, Date.now() + 1000);
    await serverDone;
    client.write('post-auth-frame');
    await new Promise(resolve => client.once('end', resolve));
    assert.equal(received, 'post-auth-frame');
  } finally { client.destroy(); await close(server); }
});

test('forged server proof receives zero application bytes', async () => {
  let received = Buffer.alloc(0);
  const server = net.createServer(socket => {
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length === 68) socket.write(Buffer.alloc(65));
    });
  });
  await listen(server);
  const discovery = newWindowsDiscovery(server.address().port);
  const client = await connect(discovery.port);
  try {
    await assert.rejects(authenticateWindowsClient(client, discovery, Date.now() + 1000),
      /windows_broker_server_unproved/);
    assert.equal(received.length, 68);
  } finally { client.destroy(); await close(server); }
});

test('silent endpoint fails the handshake deadline', async () => {
  let accepted;
  const server = net.createServer(socket => { accepted = socket; });
  await listen(server);
  const discovery = newWindowsDiscovery(server.address().port);
  const client = await connect(discovery.port);
  try {
    await assert.rejects(authenticateWindowsClient(client, discovery, Date.now() + 50),
      /windows_broker_handshake_deadline/);
  } finally { client.destroy(); accepted?.destroy(); await close(server); }
});
