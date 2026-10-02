#!/usr/bin/env node
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolveBoundLaunch } from './launch.mjs';
import { searchProject, runBridgeOperation } from './bridge.mjs';
import { createRecall, renderContext } from './context.mjs';
import { createOutbox } from './outbox.mjs';
import { POLICY_VERSION } from './transcript.mjs';

const blocked = reason => ({ kind: 'unavailable', reason });
const secret = name => process.env[name];
const definitions = [
  ['search', 'Recall approved project memory.', { query: { type: 'string' } }],
  ['source', 'Show verified local checkpoint source if present, otherwise remote provenance metadata.', { memory_id: { type: 'string' } }],
  ['propose', 'List locally captured checkpoints eligible for owner review.', {}],
  ['approve', 'Return the local owner review route; JSON cannot approve.', {}],
  ['correct', 'Return the local owner correction route; JSON cannot approve.', {}],
  ['status', 'Report the bound Mem0 session status.', {}],
].map(([name, description, properties]) => ({ name, description,
  inputSchema: { type: 'object', properties, additionalProperties: false,
    required: name === 'search' ? ['query'] : name === 'source' ? ['memory_id'] : [] } }));

export function createMcp({ launchId = process.env.CBS_MEMORIA_LAUNCH_ID,
  cli = process.env.CBS_MEMORIA_CLI, stateRoot = process.env.CBS_MEMORIA_STATE_ROOT,
  resolve = resolveBoundLaunch, search = searchProject, read = runBridgeOperation } = {}) {
  const mcpLifecycleId = randomUUID();
  const recall = createRecall({ search: async (session, query, { deadlineMs }) =>
    search({ cwd: session.cwd, sessionId: session.nativeSessionId, query }, secret,
      { stateRoot, deadlineMs }) });

  async function call(name, args = {}) {
    // This check precedes every secret access, network operation and outbox read.
    const began = performance.now();
    let timer;
    const bound = name === 'search' ? await Promise.race([
      resolve(launchId, cli, { stateRoot }),
      new Promise(done => { timer = setTimeout(() => done(blocked('deadline')), 1000); }),
    ]) : await resolve(launchId, cli, { stateRoot });
    clearTimeout(timer);
    if (bound.kind !== 'bound') return blocked(bound.reason ?? 'unbound');
    if (name === 'status') return { kind: 'bound', provider: 'mem0', projectId: bound.projectId,
      mcpLifecycleId, nativeSessionId: bound.nativeSessionId };
    if (name === 'search') {
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 4096) return blocked('invalid_query');
      const remaining = Math.floor(1000 - (performance.now() - began));
      if (remaining <= 0) return blocked('deadline');
      const result = await recall(bound, args.query, remaining);
      if (performance.now() - began >= 1000) return blocked('deadline');
      return result.kind === 'items' ? { kind: 'items', context: renderContext(result.items, 500),
        count: result.items.length } : result;
    }
    if (name === 'source') {
      if (typeof args.memory_id !== 'string' || args.memory_id.length > 256) return blocked('invalid_memory_id');
      const result = await read(bound.cwd, bound.nativeSessionId,
        { op: 'read', projectId: bound.projectId, sdkId: args.memory_id }, secret, { stateRoot });
      if (result.kind !== 'item' || result.item?.projectId !== bound.projectId) return blocked('source_unavailable');
      const item = result.item;
      const box = createOutbox(bound.stateDir);
      const rows = await box.pending();
      const source = rows.flatMap(row => row.projectId === bound.projectId &&
        row.sessionId === item.sessionId && row.policyVersion === POLICY_VERSION &&
        row.operationId === item.metadata?.checkpoint_id &&
        item.metadata?.policy_version === POLICY_VERSION ? row.messages : [])
        .find(message => message.messageId === item.metadata?.source);
      return source ? { kind: 'local_source', text: source.text, metadata: item.metadata } :
        { kind: 'remote_metadata', metadata: item.metadata,
          limitation: 'Source transcript is available only from a protected local checkpoint on its owning machine.' };
    }
    if (name === 'propose') {
      const box = createOutbox(bound.stateDir);
      const rows = await box.pending();
      const checkpoints = await Promise.all(rows.filter(row =>
        row.projectId === bound.projectId && row.policyVersion === POLICY_VERSION)
        .map(async row => {
          const manifest = await box.readManifest(row.operationId);
          return { operationId: row.operationId, cli: row.cli, sourceSessionId: row.sessionId,
            sourceCount: row.messages.length,
            candidateKeys: manifest.kind !== 'blocked' ? manifest.candidates
              .filter(item => item.status === 'pending').map(item => item.candidateKey) : [] };
        }));
      return { kind: 'pending_review', checkpoints };
    }
    if (name === 'approve' || name === 'correct') return { kind: 'blocked', reason: 'trusted_review_required',
      route: 'Run review.mjs <caller-cli> <caller-checkout> <current-native-session-id> <checkpoint-id> <candidate-key> in the owner terminal.' };
    return blocked('unknown_method');
  }
  return { mcpLifecycleId, call, compact: recall.compact };
}

export async function serveMcp(instance = createMcp()) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (line.length > 1024 * 1024) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (!Object.hasOwn(request, 'id')) continue;
    let result;
    try {
      if (request.method === 'initialize') result = { protocolVersion: '2025-03-26',
        capabilities: { tools: {} }, serverInfo: { name: 'cbs_memoria', version: '0.1.0' } };
      else if (request.method === 'tools/list') result = { tools: definitions };
      else if (request.method === 'tools/call') {
        const value = await instance.call(request.params?.name, request.params?.arguments);
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } else result = {};
    } catch { result = { content: [{ type: 'text', text: JSON.stringify(blocked('internal_error')) }] }; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  }
}

if (process.argv[1]?.endsWith('/mcp.mjs') || process.argv[1]?.endsWith('\\mcp.mjs')) await serveMcp();
