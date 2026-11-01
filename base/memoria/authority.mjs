import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { inspectConfiguration, initializeSession } from './provider.mjs';
import { localDevice } from './policy.mjs';

const blocked = reason => ({ kind: 'blocked', reason });

function markerId(resolution) {
  const hex = createHash('sha256').update(JSON.stringify(['cbs-writer-v1',
    resolution.projectId, resolution.destination.url, resolution.destination.collection]))
    .digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function writerConnection(resolution, connection) {
  return { ...connection, controlPointId: markerId(resolution) };
}

async function requestQdrant(resolution, auth, method, endpoint, body) {
  const connection = auth.connection;
  if (!connection?.url || !net.isIP(connection.address) ||
      typeof auth.key !== 'string' || !auth.key.trim()) return null;
  let target;
  try {
    if (new URL(connection.url).href !== new URL(resolution.destination.url).href) return null;
    target = new URL(endpoint, connection.url);
  } catch { return null; }
  if (!['http:', 'https:'].includes(target.protocol)) return null;
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise(resolve => {
    const req = transport.request(target, {
      method, headers: { 'api-key': auth.key, accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}) }, timeout: 5000,
      lookup: (_host, options, callback) => options.all
        ? callback(null, [{ address: connection.address, family: net.isIP(connection.address) }])
        : callback(null, connection.address, net.isIP(connection.address)),
    }, response => {
      if (response.statusCode !== 200) { response.resume(); resolve(null); return; }
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        data += chunk;
        if (data.length > 1024 * 1024) req.destroy();
      });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(endpoint === '/' || parsed.status === 'ok' ? parsed : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function ensureWriterProtocol(resolution, auth) {
  const server = await requestQdrant(resolution, auth, 'GET', '/');
  if (!server) return blocked('writer_authority_unavailable');
  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(server?.version ?? '');
  if (!version || Number(version[1]) < 1 ||
      Number(version[1]) === 1 && Number(version[2]) < 16) {
    return blocked('qdrant_atomic_claims_unavailable');
  }
  const base = `/collections/${encodeURIComponent(resolution.destination.collection)}/points`;
  const id = markerId(resolution);
  const read = () => requestQdrant(resolution, auth, 'POST', base,
    { ids: [id], with_payload: true, with_vector: false });
  const response = await read();
  if (!Array.isArray(response?.result) || response.result.length > 1) return blocked('writer_authority_unavailable');
  const current = response.result[0];
  if (current && current.id !== id) return blocked('writer_protocol_mismatch');
  const legacy = current?.payload;
  if (current && (!legacy || legacy.projectId !== resolution.projectId ||
      legacy.collection !== resolution.destination.collection ||
      !['writer_v1', 'writer_v2'].includes(legacy.cbs_control))) return blocked('writer_protocol_mismatch');
  const payload = { cbs_control: 'writer_v2', projectId: resolution.projectId,
    collection: resolution.destination.collection, mode: 'database', protocol: 2 };
  const sameMarker = value => value && typeof value === 'object' &&
    Object.keys(value).length === Object.keys(payload).length &&
    Object.entries(payload).every(([key, expected]) => value[key] === expected);
  if (legacy?.cbs_control === 'writer_v2' && !sameMarker(legacy)) {
    return blocked('writer_protocol_mismatch');
  }
  // The identical upsert proves write access even when the marker already exists.
  const written = await requestQdrant(resolution, auth, 'PUT', `${base}?wait=true&ordering=strong`,
    { points: [{ id, vector: [1, ...Array(383).fill(0)], payload }] });
  if (!written?.result || !['completed', 'acknowledged'].includes(written.result.status)) {
    return blocked('writer_authority_unavailable');
  }
  const verified = await read();
  if (!Array.isArray(verified?.result) || verified.result.length !== 1 ||
      verified.result[0].id !== id ||
      !sameMarker(verified.result[0].payload)) {
    return blocked('writer_protocol_mismatch');
  }
  return { kind: 'protocol', markerId: id };
}

export async function assertWriter(resolution, auth, options = {}) {
  if (resolution?.provider !== 'mem0' || !resolution.stateDir ||
      !resolution.projectId || !resolution.destination?.collection ||
      auth?.kind !== 'authorized') return blocked('writer_authorization_missing');
  try {
    if (await fs.lstat(path.join(resolution.stateDir, 'deactivating.json')).then(() => true,
      error => error.code === 'ENOENT' ? false : Promise.reject(error))) return blocked('deactivation_pending');
    const device = await localDevice(resolution.stateDir);
    if (device.kind !== 'device') return device;
    const protocol = options.control
      ? await options.control('ensure_v2', resolution)
      : await ensureWriterProtocol(resolution, auth);
    if (protocol.kind !== 'protocol') return protocol;
    return { kind: 'writer', deviceId: device.deviceId };
  } catch { return blocked('writer_authority_unavailable'); }
}

// Designation and transfer belong to the retired single-writer protocol. Keep the APIs
// inert so an old caller cannot overwrite writer_v1 or revoke a sibling device.
export async function bootstrapWriter() { return blocked('writer_designation_obsolete'); }
export async function beginWriterTransfer() { return blocked('writer_designation_obsolete'); }
export async function completeWriterTransfer() { return blocked('writer_designation_obsolete'); }

export async function administrativeSession(cwd, options = {}) {
  const current = await inspectConfiguration(cwd, options);
  if (current.provider !== 'mem0') return blocked(current.reason ?? 'not_mem0');
  const sessionId = `admin-${randomUUID()}`;
  const session = await initializeSession(cwd, sessionId, { ...options, event: 'SessionStart', adminSession: true });
  return session.provider === 'mem0' ? { kind: 'session', sessionId,
    resolution: session } : blocked(session.reason ?? 'admin_session_unavailable');
}
