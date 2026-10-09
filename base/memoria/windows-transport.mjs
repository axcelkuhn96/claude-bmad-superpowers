import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const header = Buffer.from('CBS-MEM0-TCP-v1\0');
const mac = (capability, domain, discovery, ...parts) => createHmac('sha256', capability)
  .update(header).update(domain).update('\0').update(discovery.generation)
  .update('\0').update(String(discovery.port)).update('\0')
  .update(Buffer.concat(parts)).digest();
const same = (left, right) => left.length === right.length && timingSafeEqual(left, right);

export function parseWindowsDiscovery(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('windows_broker_discovery_invalid'); }
  if (value?.version !== 1 || value.host !== '127.0.0.1' ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      !/^[a-f0-9]{32}$/.test(value.generation ?? '') ||
      !/^[a-f0-9]{64}$/.test(value.capability ?? '') ||
      Object.keys(value).length !== 5) throw new Error('windows_broker_discovery_invalid');
  return value;
}

export function newWindowsDiscovery(port) {
  return parseWindowsDiscovery(JSON.stringify({ version: 1, host: '127.0.0.1', port,
    generation: randomBytes(16).toString('hex'), capability: randomBytes(32).toString('hex') }));
}

function exact(socket, size, deadlineAt) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return reject(new Error('windows_broker_handshake_deadline'));
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('error', error);
      socket.off('close', close);
    };
    const fail = reason => { cleanup(); reject(new Error(reason)); };
    const data = chunk => {
      if (bytes.length + chunk.length > size) return fail('windows_broker_handshake_trailing');
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length === size) { socket.pause(); cleanup(); resolve(bytes); }
    };
    const error = () => fail('windows_broker_handshake_io');
    const close = () => fail('windows_broker_handshake_closed');
    const timer = setTimeout(() => fail('windows_broker_handshake_deadline'), remaining);
    socket.on('data', data);
    socket.once('error', error);
    socket.once('close', close);
    socket.resume();
  });
}

function write(socket, bytes, deadlineAt) {
  return new Promise((resolve, reject) => {
    if (Date.now() >= deadlineAt || socket.destroyed) return reject(new Error('windows_broker_handshake_deadline'));
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('error', io);
      socket.off('close', closed);
      if (error) reject(new Error(error)); else resolve();
    };
    const io = () => finish('windows_broker_handshake_io');
    const closed = () => finish('windows_broker_handshake_closed');
    const timer = setTimeout(() => finish('windows_broker_handshake_deadline'),
      Math.max(1, deadlineAt - Date.now()));
    socket.once('error', io);
    socket.once('close', closed);
    socket.write(bytes, error => finish(error ? 'windows_broker_handshake_io' : null));
  });
}

export async function authenticateWindowsClient(socket, discovery, deadlineAt) {
  const capability = Buffer.from(discovery.capability, 'hex');
  const nonce = randomBytes(32);
  try {
    await write(socket, Buffer.concat([Buffer.from('CM01'), nonce,
      mac(capability, 'client-hello', discovery, nonce)]), deadlineAt);
    const proof = await exact(socket, 65, deadlineAt);
    const serverNonce = proof.subarray(1, 33);
    if (proof[0] !== 0x53 || !same(proof.subarray(33),
      mac(capability, 'server-proof', discovery, nonce, serverNonce))) {
      throw new Error('windows_broker_server_unproved');
    }
    await write(socket, Buffer.concat([Buffer.from('C'),
      mac(capability, 'client-finish', discovery, nonce, serverNonce)]), deadlineAt);
    const ready = await exact(socket, 33, deadlineAt);
    if (ready[0] !== 0x52 || !same(ready.subarray(1),
      mac(capability, 'server-ready', discovery, nonce, serverNonce))) {
      throw new Error('windows_broker_server_unproved');
    }
  } finally { capability.fill(0); nonce.fill(0); }
}

export async function authenticateWindowsServer(socket, discovery, deadlineAt) {
  const capability = Buffer.from(discovery.capability, 'hex');
  const serverNonce = randomBytes(32);
  try {
    const hello = await exact(socket, 68, deadlineAt);
    const nonce = hello.subarray(4, 36);
    if (hello.toString('ascii', 0, 4) !== 'CM01' || !same(hello.subarray(36),
      mac(capability, 'client-hello', discovery, nonce))) {
      throw new Error('windows_broker_client_unproved');
    }
    await write(socket, Buffer.concat([Buffer.from('S'), serverNonce,
      mac(capability, 'server-proof', discovery, nonce, serverNonce)]), deadlineAt);
    const finish = await exact(socket, 33, deadlineAt);
    if (finish[0] !== 0x43 || !same(finish.subarray(1),
      mac(capability, 'client-finish', discovery, nonce, serverNonce))) {
      throw new Error('windows_broker_client_unproved');
    }
    await write(socket, Buffer.concat([Buffer.from('R'),
      mac(capability, 'server-ready', discovery, nonce, serverNonce)]), deadlineAt);
  } finally { capability.fill(0); serverNonce.fill(0); }
}
