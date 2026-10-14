import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { resolveProject } from './provider.mjs';
import { authorizeCurrentDestination } from './setup.mjs';
import { readQdrantSecret } from './qdrant-key.mjs';
import { selectExistingMemories } from './curation-policy.mjs';

const unavailable = reason => ({ kind: 'unavailable', reason, items: [] });

function scroll(connection, collection, key, projectId) {
  const target = new URL(`/collections/${encodeURIComponent(collection)}/points/scroll`, connection.url);
  const transport = target.protocol === 'https:' ? https : http;
  const body = JSON.stringify({ filter: { must: [
    { key: 'project_id', match: { value: projectId } },
    { key: 'status', match: { value: 'active' } },
    { key: 'scope', match: { value: 'project' } },
  ] }, limit: 64, with_payload: true, with_vector: false });
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const req = transport.request(target, {
      method: 'POST', timeout: 4000,
      headers: { 'api-key': key, accept: 'application/json',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      lookup: (_host, options, done) => options.all
        ? done(null, [{ address: connection.address, family: net.isIP(connection.address) }])
        : done(null, connection.address, net.isIP(connection.address)),
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(unavailable('remote_status'));
        return;
      }
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        data += chunk;
        if (Buffer.byteLength(data, 'utf8') > 256 * 1024) req.destroy();
      });
      response.once('end', () => {
        try {
          const parsed = JSON.parse(data);
          const result = parsed?.result;
          if (!Array.isArray(result?.points)) finish(unavailable('remote_schema'));
          else if (result.points.length > 64) finish({ kind: 'saturated', items: [],
            scanned: result.points.length });
          else if (result.next_page_offset != null) finish({ kind: 'saturated', items: [],
            scanned: result.points.length });
          else finish({ kind: 'ready', points: result.points, scanned: result.points.length });
        } catch { finish(unavailable('remote_schema')); }
      });
    });
    const deadline = setTimeout(() => req.destroy(), 5000);
    req.once('timeout', () => req.destroy());
    req.once('error', () => finish(unavailable('remote_unavailable')));
    req.end(body);
  });
}

export async function readExistingMemories(row, cliPolicy, options = {}) {
  if (!options.contextCwd || !row?.sessionId || !row?.projectId ||
      !cliPolicy?.autoPublishConsent?.enabled) return unavailable('context_not_configured');
  try {
    const stateRoot = options.stateRoot;
    const resolution = await (options.resolveProject ?? resolveProject)(
      options.contextCwd, row.sessionId, { stateRoot });
    const frozen = cliPolicy.autoPublishConsent;
    if (resolution?.provider !== 'mem0' || resolution.projectId !== row.projectId ||
        resolution.ownerId !== frozen.ownerId ||
        resolution.extractor?.autoPublishConsent?.consentHash !== frozen.consentHash) {
      return unavailable('context_identity_changed');
    }
    const authorized = await (options.authorize ?? authorizeCurrentDestination)(
      options.contextCwd, row.sessionId, options.readSecret ?? readQdrantSecret,
      { stateRoot, deadlineAt: Date.now() + 5000 });
    if (authorized.kind !== 'authorized') return unavailable(authorized.reason ?? 'context_untrusted');
    const result = await (options.scroll ?? scroll)(authorized.connection,
      resolution.destination.collection, authorized.key, row.projectId);
    if (result.kind !== 'ready') return result;
    return { kind: 'ready', scanned: result.scanned,
      items: selectExistingMemories(result.points, { projectId: row.projectId,
        ownerId: frozen.ownerId, query: row.messages.map(message => message.text ?? '').join(' '),
        isSafe: options.isSafe ?? (() => true) }) };
  } catch { return unavailable('context_unavailable'); }
}
