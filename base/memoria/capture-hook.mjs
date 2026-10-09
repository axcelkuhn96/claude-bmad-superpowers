#!/usr/bin/env node
import { captureEvent } from './checkpoint.mjs';
import { scheduleExtraction } from './extract-worker.mjs';

const [cli, event] = process.argv.slice(2);
const began = 0; // Count native hook process startup/import and capture in the recall budget.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
}
try {
  const payload = JSON.parse(input);
  const result = await captureEvent({ cli, event, payload, stateRoot: process.env.CBS_MEMORIA_STATE_ROOT });
  scheduleExtraction({ cli, event, payload, result, stateRoot: process.env.CBS_MEMORIA_STATE_ROOT });
  if (event === 'UserPromptSubmit' || event === 'PreCompact') {
    const { recallForPrompt } = await import('./hook-recall.mjs');
    const recall = await recallForPrompt({ cli, event, payload, result,
      stateRoot: process.env.CBS_MEMORIA_STATE_ROOT, began,
      onFailure: category => process.stderr.write(`CBS Mem0 recall: ${category}\n`) });
    if (recall) process.stdout.write(JSON.stringify(recall) + '\n');
  } else if (result.kind === 'full' || result.kind === 'blocked' && result.reason !== 'not_mem0') {
    process.stderr.write(`CBS Mem0 capture: ${result.reason === 'trust_changed' ? 'trust' : 'capture'}\n`);
  }
} catch {
  process.stderr.write('CBS Mem0 capture: error\n');
}
