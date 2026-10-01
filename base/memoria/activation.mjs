import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
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

async function addressesFor(host) {
  return (await dns.lookup(host, { all: true })).map(({ address }) => address);
}

async function probeCollection(url, collection, key, address) {
  const target = new URL(`/collections/${encodeURIComponent(collection)}`, url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = transport.get(target, {
      headers: { 'api-key': key, accept: 'application/json' }, timeout: 5000,
      lookup: (_host, _options, callback) => callback(null, address, net.isIP(address)),
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy();
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
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
  let target;
  try { target = new URL(resolution.destination.url); } catch { return blocked('invalid_destination'); }
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) return blocked('invalid_destination');
  let addresses;
  try { addresses = await (deps.lookup ?? addressesFor)(target.hostname); }
  catch { return blocked('destination_unavailable'); }
  addresses = addresses.map((item) => typeof item === 'string' ? item : item.address);
  if (!addresses.length || addresses.some((address) => !privateAddress(address)) ||
      (target.protocol === 'http:' && addresses.some((address) => !['127.0.0.1', '::1'].includes(address)))) {
    return blocked('public_destination');
  }
  const auth = authorizeDestination(resolution, approved, deps.readSecret);
  if (auth.kind !== 'authorized') return auth;
  if (deps.isCurrent && !await deps.isCurrent()) return blocked('config_changed');
  let details;
  try {
    details = await (deps.probeCollection ?? probeCollection)(target.toString(),
      resolution.destination.collection, auth.key, addresses[0]);
  } catch { return blocked('collection_unavailable'); }
  if (!details?.result?.config) return blocked('collection_unavailable');
  const config = details.result.config;
  if (config.params?.vectors?.size !== 384 || config.params.vectors.distance !== 'Cosine' ||
      config.metadata?.cbs_embedding_fingerprint !== embeddingFingerprint) {
    return blocked('collection_incompatible');
  }
  return { kind: 'authorized', tuple: expected };
}
