import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { authorizeDestination, trustTuple } from './trust.mjs';

const blocked = (reason) => ({ kind: 'blocked', reason });

function privateAddress(address) {
  if (net.isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(lower);
  }
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || a === 127;
}

async function addressesFor(host, deps) {
  const remaining = (deps.deadlineAt ?? Date.now() + 5000) - Date.now();
  if (remaining <= 0 || deps.signal?.aborted) return blocked('deadline');
  const child = (deps.spawnLookup ?? spawn)(process.execPath, ['-e',
    'require("node:dns").lookup(process.argv[1],{all:true},(error,rows)=>{if(error)process.exitCode=1;else process.stdout.write(JSON.stringify(rows.map(row=>row.address)))})', host],
  { stdio: ['ignore', 'pipe', 'ignore'], env: {} });
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener('abort', abort);
      if (value?.kind === 'blocked') child.kill('SIGKILL');
      resolve(value);
    };
    const abort = () => finish(blocked('deadline'));
    const timer = setTimeout(abort, remaining);
    deps.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 16384) finish(blocked('destination_unavailable'));
    });
    child.once('error', () => finish(blocked('destination_unavailable')));
    child.once('close', code => {
      try { finish(code === 0 ? JSON.parse(output) : blocked('destination_unavailable')); }
      catch { finish(blocked('destination_unavailable')); }
    });
  });
}

async function probeCollection(url, collection, key, address) {
  const target = new URL(`/collections/${encodeURIComponent(collection)}`, url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = transport.get(target, {
      headers: key ? { 'api-key': key, accept: 'application/json' } : { accept: 'application/json' }, timeout: 5000,
      lookup: (_host, _options, callback) => callback(null, address, net.isIP(address)),
    }, (res) => {
      if (res.statusCode !== 200 || !key) { res.resume(); resolve({ statusCode: res.statusCode }); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy();
      });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, body: JSON.parse(body) }); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

export async function pinDestination(url, deps = {}) {
  let target;
  try { target = new URL(url); } catch { return blocked('invalid_destination'); }
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) return blocked('invalid_destination');
  let addresses;
  try { addresses = deps.lookup ? await deps.lookup(target.hostname) : await addressesFor(target.hostname, deps); }
  catch { return blocked('destination_unavailable'); }
  if (addresses?.kind === 'blocked') return addresses;
  if (deps.deadlineAt != null && Date.now() >= deps.deadlineAt || deps.signal?.aborted) return blocked('deadline');
  if (!Array.isArray(addresses)) return blocked('destination_unavailable');
  addresses = addresses.map((item) => typeof item === 'string' ? item : item.address);
  if (!addresses.length || addresses.some((address) => !privateAddress(address)) ||
      (target.protocol === 'http:' && addresses.some((address) => !['127.0.0.1', '::1'].includes(address)))) {
    return blocked('public_destination');
  }
  return { kind: 'pinned', connection: Object.freeze({ url: target.toString(),
    hostname: target.hostname, address: addresses[0], port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
    protocol: target.protocol, servername: target.hostname }) };
}

export async function validateDestination(resolution, embeddingFingerprint, deps) {
  if (resolution?.provider !== 'mem0' || typeof deps?.approve !== 'function' ||
      typeof deps?.readSecret !== 'function') return blocked('invalid_activation');
  const expected = trustTuple(resolution);
  const approved = await deps.approve(expected);
  if (!approved || Object.entries(expected).some(([key, value]) => approved[key] !== value)) {
    return blocked('trust_changed');
  }
  if (deps.isCurrent && !await deps.isCurrent()) return blocked('config_changed');
  const pin = await pinDestination(resolution.destination.url, deps);
  if (pin.kind !== 'pinned') return pin;
  const { connection } = pin;
  const auth = authorizeDestination(resolution, approved, deps.readSecret);
  if (auth.kind !== 'authorized') return auth;
  if (deps.isCurrent && !await deps.isCurrent()) return blocked('config_changed');
  let anonymous;
  try { anonymous = await (deps.probeCollection ?? probeCollection)(connection.url,
    resolution.destination.collection, undefined, connection.address); }
  catch { return blocked('collection_unavailable'); }
  if (![401, 403].includes(anonymous?.statusCode)) return blocked('unprotected_destination');
  if (deps.isCurrent && !await deps.isCurrent()) return blocked('config_changed');
  let details;
  try {
    details = await (deps.probeCollection ?? probeCollection)(connection.url,
      resolution.destination.collection, auth.key, connection.address);
  } catch { return blocked('collection_unavailable'); }
  if (details?.statusCode !== 200 || !details?.body?.result?.config) return blocked('collection_unavailable');
  const config = details.body.result.config;
  if (config.params?.vectors?.size !== 384 || config.params.vectors.distance !== 'Cosine' ||
      config.metadata?.cbs_embedding_fingerprint !== embeddingFingerprint) {
    return blocked('collection_incompatible');
  }
  return { kind: 'authorized', tuple: expected };
}
