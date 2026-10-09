#!/usr/bin/env node
// The native fixture owns this child and terminates it only after a production durability boundary.
import { createOutbox } from '../base/memoria/outbox.mjs';
import { createWindowsState } from '../base/memoria/windows-state.mjs';
import { storeMemory } from '../base/memoria/bridge.mjs';
import path from 'node:path';
import fs from 'node:fs';

const input = JSON.parse(process.argv[2] ?? '{}');
if (process.platform !== 'win32' || !input.stateDir || !input.mode) {
  throw new Error('native_crash_child_args');
}
const reached = (boundary, metadata = {}) => {
  if (boundary !== input.boundary) return;
  fs.writeSync(1, JSON.stringify({ boundary, nonce: input.nonce, metadata }) + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);
  throw new Error('native_crash_parent_timeout');
};

if (input.mode === 'state') {
  await createWindowsState(input.file, { onBoundary: reached }).write(input.next);
} else if (input.mode === 'remote_add') {
  const box = createOutbox(input.stateDir);
  await storeMemory(input.cwd, input.sessionId, input.operation,
    name => process.env[name], { stateRoot: input.stateRoot, writerId: input.writerId,
      ackLocal: (id, proof) => box.ackVerified(id, proof),
      onRemoteAdd: () => reached('remote_add_durable') });
} else {
  const box = createOutbox(input.stateDir, { maxBytes: input.maxBytes,
    onTempFlushed: observation => {
      if (input.mode === 'temp' && /^src-[a-f0-9]{64}\.json$/.test(path.basename(observation.target)) &&
          path.basename(path.dirname(observation.target)) === 'items') {
        reached('temp_flushed_before_publish', observation);
      }
    },
    onDurable: file => reached(
    file.includes('.manifest.json') ? 'manifest_durable' :
      path.basename(file) === `${input.operationId}.json` && file.includes('processed') ? 'receipt_durable' :
        /^src-[a-f0-9]{64}\.json$/.test(path.basename(file)) && file.includes('items') ? 'item_durable' :
          file.includes('cursor-') ? 'cursor_durable' : 'other_durable', { file }) });
  if (input.mode === 'item' || input.mode === 'temp' || input.mode === 'cursor') {
    await box.enqueueCheckpoint(input.slice, input.identity);
  }
  else if (input.mode === 'manifest') await box.recordManifest(input.operationId, []);
  else if (input.mode === 'receipt') await box.completeCheckpoint(input.operationId);
  else throw new Error('native_crash_child_mode');
}
throw new Error('native_crash_boundary_not_reached');
